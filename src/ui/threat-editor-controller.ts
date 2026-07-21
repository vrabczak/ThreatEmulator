/**
 * Owns threat editor form state, validation, and delegated list edit/delete actions.
 * Domain validation stays in `threat-editor`; application state changes are returned by callback.
 */

import {
  buildThreatFromEditor,
  formatMgrsCoordinate,
  type ThreatPositionMode
} from '../domain/threat-editor';
import type { AircraftState, Threat } from '../domain/types';
import { getElement } from './dom';

export interface ThreatEditorControllerOptions {
  getThreats: () => Threat[];
  getAircraftState: () => AircraftState | null;
  onThreatsChanged: (threats: Threat[], message: string) => void;
}

/**
 * Coordinates the threat editor and list actions for the lifetime of the mounted page.
 * The controller keeps only the active edit index; the canonical threat list remains in app state.
 */
export class ThreatEditorController {
  private readonly form = getElement<HTMLFormElement>('threatEditor');
  private editingThreatIndex: number | null = null;

  /**
   * Creates the controller and binds the static form and delegated table events.
   * @param options - State accessors and the callback used to commit list changes.
   */
  public constructor(private readonly options: ThreatEditorControllerOptions) {
    getElement<HTMLButtonElement>('addThreatButton').addEventListener('click', () => this.open());
    getElement<HTMLButtonElement>('cancelThreatButton').addEventListener('click', () => this.close());
    this.form.addEventListener('change', (event) => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.name === 'positionMode') {
        this.refreshPositionFields();
      }
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.save();
    });
    getElement<HTMLTableSectionElement>('threatRows').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-threat-action]');
      if (!button) {
        return;
      }
      const index = Number(button.dataset.threatIndex);
      if (!Number.isInteger(index) || !this.options.getThreats()[index]) {
        return;
      }
      if (button.dataset.threatAction === 'edit') {
        this.open(index);
      } else if (button.dataset.threatAction === 'delete') {
        this.delete(index);
      }
    });
  }

  /**
   * Closes the editor and clears its transient edit target and validation message.
   * @returns Nothing.
   */
  public close(): void {
    this.editingThreatIndex = null;
    this.form.hidden = true;
    getElement('threatEditorErrors').hidden = true;
  }

  /**
   * Synchronizes position-field visibility and the aircraft-relative placement hint.
   * @returns Nothing.
   */
  public refreshPositionFields(): void {
    const positionMode = this.selectedPositionMode();
    getElement('coordinatePositionFields').hidden = positionMode !== 'coordinates';
    getElement('mgrsPositionFields').hidden = positionMode !== 'mgrs';
    getElement('relativePositionFields').hidden = positionMode !== 'relative';
    const aircraftState = this.options.getAircraftState();
    getElement('relativePositionHint').textContent = aircraftState
      ? `Aircraft reference: ${aircraftState.latitude.toFixed(6)}, ${aircraftState.longitude.toFixed(6)}`
      : 'Waiting for an aircraft GNSS position.';
  }

  private open(index: number | null = null): void {
    const threats = this.options.getThreats();
    const threat = index === null ? null : threats[index];
    if (index !== null && !threat) {
      return;
    }

    this.editingThreatIndex = index;
    this.form.reset();
    this.setInputValue('threatId', threat?.id ?? this.nextThreatId(threats));
    this.setInputValue('threatName', threat?.name ?? '');
    this.setInputValue('threatHeightAglM', threat?.heightAglM === null || !threat ? '' : String(threat.heightAglM));
    this.setInputValue('threatRangeKm', threat ? String(threat.rangeKm) : '');
    this.setInputValue('threatLatitude', threat ? String(threat.latitude) : '');
    this.setInputValue('threatLongitude', threat ? String(threat.longitude) : '');
    const threatMgrs = threat ? formatMgrsCoordinate(threat) : null;
    this.setInputValue('threatMgrs', threatMgrs ?? '');
    if (threat && !threatMgrs) {
      this.setSelectedPositionMode('coordinates');
    }
    this.setInputValue('threatBearing', '');
    this.setInputValue('threatDistanceKm', '');
    getElement('threatEditorTitle').textContent = threat ? `Edit ${threat.id}` : 'Add threat';
    getElement('threatEditorErrors').hidden = true;
    this.form.hidden = false;
    getElement<HTMLDetailsElement>('evaluationPanel').open = true;
    this.refreshPositionFields();
    getElement<HTMLInputElement>('threatId').focus();
  }

  private save(): void {
    const threats = this.options.getThreats();
    const result = buildThreatFromEditor(
      {
        id: this.inputValue('threatId'),
        name: this.inputValue('threatName'),
        heightAglM: this.inputValue('threatHeightAglM'),
        rangeKm: this.inputValue('threatRangeKm'),
        positionMode: this.selectedPositionMode(),
        latitude: this.inputValue('threatLatitude'),
        longitude: this.inputValue('threatLongitude'),
        mgrs: this.inputValue('threatMgrs'),
        bearingDegrees: this.inputValue('threatBearing'),
        distanceKm: this.inputValue('threatDistanceKm')
      },
      this.options.getAircraftState(),
      threats.filter((_, index) => index !== this.editingThreatIndex).map((threat) => threat.id)
    );

    if (!('threat' in result)) {
      const errors = getElement('threatEditorErrors');
      errors.textContent = result.errors.join(' ');
      errors.hidden = false;
      return;
    }

    const previous = this.editingThreatIndex === null ? null : threats[this.editingThreatIndex];
    const nextThreats = this.editingThreatIndex === null
      ? [...threats, result.threat]
      : threats.map((threat, index) => index === this.editingThreatIndex ? result.threat : threat);
    this.close();
    this.options.onThreatsChanged(
      nextThreats,
      previous ? `Threat ${previous.id} updated.` : `Threat ${result.threat.id} added.`
    );
  }

  private delete(index: number): void {
    const threats = this.options.getThreats();
    const threat = threats[index];
    const description = threat.name ? ` (${threat.name})` : '';
    if (!window.confirm(`Delete threat ${threat.id}${description}?`)) {
      return;
    }
    this.close();
    this.options.onThreatsChanged(
      threats.filter((_, threatIndex) => threatIndex !== index),
      `Threat ${threat.id} deleted.`
    );
  }

  private selectedPositionMode(): ThreatPositionMode {
    const value = this.form.querySelector<HTMLInputElement>('input[name="positionMode"]:checked')?.value;
    return value === 'mgrs' || value === 'relative' ? value : 'coordinates';
  }

  private setSelectedPositionMode(mode: ThreatPositionMode): void {
    const input = this.form.querySelector<HTMLInputElement>(
      `input[name="positionMode"][value="${mode}"]`
    );
    if (input) {
      input.checked = true;
    }
  }

  private inputValue(id: string): string {
    return getElement<HTMLInputElement>(id).value;
  }

  private setInputValue(id: string, value: string): void {
    getElement<HTMLInputElement>(id).value = value;
  }

  private nextThreatId(threats: Threat[]): string {
    const ids = new Set(threats.map((threat) => threat.id));
    let number = 1;
    while (ids.has(`T${String(number).padStart(3, '0')}`)) {
      number += 1;
    }
    return `T${String(number).padStart(3, '0')}`;
  }
}

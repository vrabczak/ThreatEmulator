/**
 * Boots the browser application by mounting its shell and starting the top-level controller.
 * Vite supplies service-worker registration and stylesheet bundling for this entry module.
 */

import { registerSW } from 'virtual:pwa-register';
import { ThreatEmulatorApp } from './threat-emulator-app';
import { mountAppShell } from './ui/dom';
import './styles.css';

registerSW({ immediate: true });
mountAppShell();

const app = new ThreatEmulatorApp();
app.start();

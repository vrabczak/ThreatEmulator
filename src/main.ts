/**
 * Boots the browser application by mounting its shell, restoring the theme, and starting the top-level controller.
 * Vite supplies service-worker registration and stylesheet bundling for this entry module.
 */

import { registerSW } from 'virtual:pwa-register';
import { ThreatEmulatorApp } from './threat-emulator-app';
import { mountAppShell } from './ui/dom';
import { initializeThemeToggle } from './ui/theme';
import './styles.css';

registerSW({ immediate: true });
mountAppShell();
initializeThemeToggle();

const app = new ThreatEmulatorApp();
app.start();

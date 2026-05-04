/**
 * usbcompass.js - USB compass heading source
 *
 * Parses serial output from the mast compass Arduino:
 *   timestamp, heading_deg, angle0, angle1, cal_status
 * Example: 19.72,226.92,-0.60,-0.29,0
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

let usbPort = '/dev/ttyUSB0';
let baudRate = 9600;
let DEBUG = false;
let VERBOSE = false;

let onMastHeadingUpdate = null;
let onConnectionStatusChange = null;

let port = null;
let connected = false;

function init(config) {
  usbPort    = config.usbPort  || '/dev/ttyUSB0';
  baudRate   = config.baudRate || 9600;
  DEBUG      = config.debug    || false;
  VERBOSE    = config.verbose  || false;
  onMastHeadingUpdate    = config.onMastHeadingUpdate    || null;
  onConnectionStatusChange = config.onConnectionStatusChange || null;
}

function start() {
  console.log(`[usbcompass] Opening ${usbPort} at ${baudRate} baud`);

  port = new SerialPort({ path: usbPort, baudRate }, (err) => {
    if (err) {
      console.error(`[usbcompass] Failed to open ${usbPort}: ${err.message}`);
      connected = false;
      if (onConnectionStatusChange) onConnectionStatusChange(false);
      // retry
      setTimeout(start, 5000);
      return;
    }
    console.log(`[usbcompass] Connected to ${usbPort}`);
    connected = true;
    if (onConnectionStatusChange) onConnectionStatusChange(true);
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  parser.on('data', (line) => {
    line = line.trim();
    if (!line) return;

    const parts = line.split(',');
    if (parts.length < 2) {
      if (DEBUG) console.log(`[usbcompass] Skipping malformed line: ${line}`);
      return;
    }

    const headingDeg = parseFloat(parts[1]);
    if (isNaN(headingDeg)) {
      if (DEBUG) console.log(`[usbcompass] Could not parse heading from: ${line}`);
      return;
    }

    const headingRad = headingDeg * Math.PI / 180;

    if (VERBOSE) {
      const ts      = parts[0];
      const angle0  = parts[2] !== undefined ? parts[2] : '?';
      const angle1  = parts[3] !== undefined ? parts[3] : '?';
      const calStat = parts[4] !== undefined ? parts[4].trim() : '?';
      console.log(`[usbcompass] ts=${ts} hdg=${headingDeg.toFixed(2)}° angle=[${angle0},${angle1}] cal=${calStat}`);
    }

    if (onMastHeadingUpdate) onMastHeadingUpdate(headingRad);
  });

  port.on('error', (err) => {
    console.error(`[usbcompass] Serial error: ${err.message}`);
    connected = false;
    if (onConnectionStatusChange) onConnectionStatusChange(false);
  });

  port.on('close', () => {
    console.log(`[usbcompass] Port closed, retrying in 5s...`);
    connected = false;
    if (onConnectionStatusChange) onConnectionStatusChange(false);
    port = null;
    setTimeout(start, 5000);
  });
}

function stop() {
  if (port && port.isOpen) {
    port.close();
  }
  port = null;
  connected = false;
}

function isConnected() {
  return connected;
}

module.exports = { init, start, stop, isConnected };

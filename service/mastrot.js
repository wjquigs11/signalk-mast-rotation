#!/usr/bin/env node
const { FromPgn, toPgn } = require('@canboat/canboatjs');
const { parseCanId } = require('@canboat/canboatjs/dist/canId');
const socketcan = require('socketcan');
const minimist = require('minimist');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

const signalk = require('./signalk');
const pypilot = require('./pypilot');
const honey = require('./honey');
const espcompass = require('./espcompass');
const argv = minimist(process.argv.slice(2), {
  string: ['wind', 'skServer', 'clientId', 'mastHost', 'boatHost', 'headingDevice', 'honey', 'esphost'],
  boolean: ['debug', 'report', 'transmitHeading', 'headingOnly', 'mag', 'true', 'local'],
  default: {
    wind: 'can1',
    skServer: 'localhost',
    skPort: 3000,
    debug: false,
    report: false,
    transmitHeading: false,
    headingOnly: false,
    headingDevice: 'can0',
    clientId: 'mast-rotation',
    mastHost: '10.1.1.1',
    boatHost: 'localhost',
    pypilotPort: 23322,
    mag: true,
    true: false,
    local: true,
    honey: null,
    honeyPort: 80,
    esphost: null,
    espPort: 80
  }
});
const USE_LOCAL  = argv.local;
const USE_HONEY  = !!argv.honey;
const USE_ESP    = !!argv.esphost;
const HONEY_CENTER_THRESHOLD_DEG = 0.5; // auto-center when |mastAngle| < this
const USE_MAG = argv['true'] === true ? argv['mag'] === true : true;
const USE_TRUE = argv['true'] === true;
const DEBUG = argv.debug;
const VERBOSE = argv.verbose || DEBUG;
const REPORT_MODE = argv.report;
const TRANSMIT_HEADING = argv.transmitHeading;
const HEADING_ONLY = argv.headingOnly;
const headingDevice = argv.headingDevice;

let headingChannel = null;

function initHeadingTransmit() {
  try {
    headingChannel = socketcan.createRawChannel(headingDevice);
    headingChannel.addListener('onStopped', () => {
      console.error(`Heading CAN channel stopped`);
      headingChannel = null;
    });
    headingChannel.start();
    console.log(`Heading transmit channel started on ${headingDevice}`);
  } catch (e) {
    console.error(`Failed to open heading CAN device ${headingDevice}: ${e.message}`);
    headingChannel = null;
  }
}

function transmitMastHeading(headingRadians) {
  if (!headingChannel) return;
  try {
    const corrected = normalizeAngle(headingRadians + mastHeadingOffset);
    const pgnData = {
      pgn: 127250,
      'Heading': corrected,
      'Reference': 'Magnetic'
    };
    const canData = toPgn(pgnData);
    if (!canData) return;
    const dataBuffer = Buffer.isBuffer(canData) ? canData : Buffer.from(canData);
    const canId = (2 << 26) | (127250 << 8) | 255;
    headingChannel.send({ id: canId, data: dataBuffer, ext: true });
    if (DEBUG) {
      console.log(`Transmitted PGN 127250: Heading=${radToDegree(corrected).toFixed(1)}°`);
    }
  } catch (e) {
    console.error(`Error transmitting heading: ${e.message}`);
  }
}

if (DEBUG) {
  console.log('Debug mode enabled');
}
if (VERBOSE && !DEBUG) {
  console.log('Verbose mode enabled');
}
if (REPORT_MODE) {
  console.log('Report mode enabled - mast angle will be reported without modifying wind data');
}
let windCanDevice = argv.wind;
const skServer = argv.skServer;
const skPort = argv.skPort;
const clientId = argv.clientId;
let mastHost = argv.mastHost;
let boatHost = argv.boatHost;
let pypilotPort = argv.pypilotPort;
const tokenFilePath = path.join(process.cwd(), 'mastrot-token');
let mastAngle = null;    // primary mast rotation angle (used for wind correction)
let mastAngleTrue = null; // true-based (display only)
let mastAngleHoney = null; // Honeywell direct angle (display only)
let mastOffset = 0; 
// Heading offsets — Center sets these so all headings align to RTK true
let pypilotOffset = 0;   // offset applied to pypilot heading
let espOffset = 0;       // offset applied to ESP heading
let mastHeadingOffset = 0; // offset applied to mast heading
let lastMastAngleUpdate = 0; 
let toggleCorrect = true;
console.log(`Wind CAN device: ${windCanDevice}`);
console.log(`SignalK server: ${skServer}`);
console.log(`Signalk port: ${skPort}`);
let inputAWA = null;
let inputAWS = null;
let outputAWA = null;
let boatHeadingPypilotMag = null;  // magnetic heading from pypilot
let boatHeadingRTKTrue = null;     // true heading from SignalK (RTK) — reference
let boatHeadingESP = null;         // magnetic heading from ESP32 BNO08x via SSE
let canHeading = null;             // mast heading (raw)
let honeyCentered = false;  // debounce flag for honey auto-center
const windParser = new FromPgn({
  returnNulls: true,
  checkForInvalidFields: true,
  includeInputData: true,
  createPGNObjects: true,
  resolveEnums: true,
  canBus: windCanDevice
});
windParser.on('error', (pgn, error) => {
  console.error(`Error parsing wind data: ${error}`);
  console.error(error.stack);
});
windParser.on('pgn', (pgn) => {
  if (pgn.pgn === 130306) {
    if (pgn.fields) {
      inputAWA = pgn.fields.windAngle;
      inputAWS = pgn.fields.windSpeed;
      if (VERBOSE) {
        console.log(`Wind Data: AWA=${radToDegree(mapAngleToDisplayRange(inputAWA)).toFixed(1)}°, AWS=${inputAWS.toFixed(1)} m/s`);
      }
      if (boatHeadingPypilotMag !== null && canHeading !== null) {
        const previousMastAngle = mastAngle;
        updateMastAngle();
        if (previousMastAngle !== null && Math.abs(mastAngle - previousMastAngle) > 0.01) {
        }
        outputAWA = normalizeAngle(inputAWA + mastAngle);
      } else {
        outputAWA = inputAWA;
      }
      const values = [];
      if (!REPORT_MODE) {
        const windAngle = (toggleCorrect && outputAWA) ? outputAWA : (pgn.fields.windAngle || 0);
        values.push(
          { path: 'environment.wind.angleApparent', value: windAngle },
          { path: 'environment.wind.speedApparent', value: pgn.fields.windSpeed || 0 },
          { path: 'environment.wind.angleApparentRaw', value: inputAWA !== null ? inputAWA : 0 }
        );
      }
      if (mastAngle !== null) {
        values.push({
          path: 'sailing.mastAngle',
          value: mapAngleToDisplayRange(mastAngle)
        });
        lastMastAngleUpdate = Date.now();
      }
      if (!HEADING_ONLY) {
        signalk.forwardWindData({ 
          values,
          debug: {
            inputAWA: inputAWA,
            boatHeading: boatHeadingPypilotMag,
            mastHeading: canHeading
          }
        });
      }
    }
  }
});

console.log(`Opening CAN device: ${windCanDevice}`);
const windChannel = HEADING_ONLY ? null : socketcan.createRawChannel(windCanDevice);
if (windChannel) {
windChannel.addListener('onStopped', (msg) => {
  console.error(`Wind CAN channel stopped: ${msg}`);
});
windChannel.addListener('onMessage', (msg) => {
  const pgn = parseCanId(msg.id);
  if (pgn.pgn === 130306) {
    windParser.parse({
      pgn: pgn,
      length: msg.data.length,
      data: msg.data
    });
  }
});
}
async function saveConfig() {
  try {
    const configFilePath = path.join(process.cwd(), 'mastrot-config.json');
    const config = {
      mastOffset: mastOffset,
      pypilotOffset: pypilotOffset,
      espOffset: espOffset,
      mastHeadingOffset: mastHeadingOffset,
      toggleCorrect: toggleCorrect
    };
    await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));
    console.log(`Saved config to local file: mastOffset=${mastOffset}, windCorrection=${toggleCorrect ? 'enabled' : 'disabled'}`);
  } catch (error) {
    console.error(`Error saving config to local file: ${error.message}`);
  }
}
function normalizeAngle(angle) {
  while (angle < 0) angle += 2 * Math.PI;
  while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
  return angle;
}
function mapAngleToDisplayRange(angle) {
  const normalizedAngle = normalizeAngle(angle);
  if (normalizedAngle > Math.PI) {
    return normalizedAngle - 2 * Math.PI; 
  }
  return normalizedAngle;
}
function radToDegree(radians) {
  return radians * 180 / Math.PI;
}
function calculateHeadingDifference(heading1, heading2) {
  return Math.atan2(Math.sin(heading2 - heading1), Math.cos(heading2 - heading1));
}

async function initialize() {
  try {
    console.log('Initializing PGN Monitor...');
    const configFilePath = path.join(process.cwd(), 'mastrot-config.json');
    try {
      if (await fs.pathExists(configFilePath)) {
        const configData = await fs.readFile(configFilePath, 'utf8');
        if (configData && configData.trim()) {
          const config = JSON.parse(configData);
          if (config.mastOffset !== undefined) {
            mastOffset = parseFloat(config.mastOffset);
            console.log(`Loaded mastOffset ${mastOffset} from local file`);
          }
          if (config.pypilotOffset !== undefined) {
            pypilotOffset = parseFloat(config.pypilotOffset);
            console.log(`Loaded pypilotOffset ${radToDegree(pypilotOffset).toFixed(2)}° from local file`);
          }
          if (config.espOffset !== undefined) {
            espOffset = parseFloat(config.espOffset);
            console.log(`Loaded espOffset ${radToDegree(espOffset).toFixed(2)}° from local file`);
          }
          if (config.mastHeadingOffset !== undefined) {
            mastHeadingOffset = parseFloat(config.mastHeadingOffset);
            console.log(`Loaded mastHeadingOffset ${radToDegree(mastHeadingOffset).toFixed(2)}° from local file`);
          }
          if (config.toggleCorrect !== undefined) {
            toggleCorrect = config.toggleCorrect;
            console.log(`Loaded wind correction state: ${toggleCorrect ? 'enabled' : 'disabled'}`);
          }
          if (config.windCanDevice !== undefined) {
            windCanDevice = config.windCanDevice;
            console.log(`Loaded windCanDevice ${windCanDevice} from config file`);
          }
          if (config.mastHost !== undefined) {
            mastHost = config.mastHost;
            console.log(`Loaded mastHost ${mastHost} from config file`);
          }
          if (config.boatHost !== undefined) {
            boatHost = config.boatHost;
            console.log(`Loaded boatHost ${boatHost} from config file`);
          }
          if (config.pypilotPort !== undefined) {
            pypilotPort = config.pypilotPort;
            console.log(`Loaded pypilotPort ${pypilotPort} from config file`);
          }
        }
      }
    } catch (error) {
      console.error(`Error loading config from local file: ${error.message}`);
      const offsetFilePath = path.join(process.cwd(), 'mastrot-offset');
      try {
        if (await fs.pathExists(offsetFilePath)) {
          const offsetValue = await fs.readFile(offsetFilePath, 'utf8');
          if (offsetValue && offsetValue.trim()) {
            mastOffset = parseFloat(offsetValue.trim());
            console.log(`Loaded mastOffset ${mastOffset} from legacy file`);
          }
        }
      } catch (legacyError) {
        console.error(`Error loading from legacy file: ${legacyError.message}`);
      }
    }
    if (mastOffset === 0 && process.env.MASTROT_OFFSET) {
      mastOffset = parseFloat(process.env.MASTROT_OFFSET);
      console.log(`Using mastOffset from environment: ${mastOffset}`);
    }
    if (mastOffset === 0) {
      console.log(`No saved mastOffset found, using default: ${mastOffset}`);
    }
    if (!HEADING_ONLY) {
      signalk.init({
        skServer: skServer,
        skPort: skPort,
        clientId: clientId,
        tokenFilePath: tokenFilePath,
        debug: DEBUG,
        verbose: VERBOSE,
        subscribeTrue: USE_TRUE,
        onBoatHeadingTrueUpdate: (heading) => {
          boatHeadingRTKTrue = heading;
          if (VERBOSE) console.log(`Boat Heading RTK (true): ${radToDegree(heading).toFixed(1)}°`);
          if (canHeading !== null && boatHeadingPypilotMag !== null) updateMastAngle();
        },
        onConnectionStatusChange: (connected) => {
          console.log(`SignalK connection status: ${connected ? 'connected' : 'disconnected'}`);
        }
      });
      signalk.start();
    }
    // ── Local pypilot source (--local) ──────────────────────────────────
    if (USE_LOCAL) {
      pypilot.init({
        mastHost: mastHost,
        boatHost: boatHost,
        pypilotPort: pypilotPort,
        debug: DEBUG,
        verbose: VERBOSE,
        onMastHeadingUpdate: (heading) => {
          canHeading = heading;
          if (VERBOSE) console.log(`Mast Heading (pypilot): ${radToDegree(heading).toFixed(1)}°`);
          if (TRANSMIT_HEADING) transmitMastHeading(heading);
          if (boatHeadingPypilotMag !== null) updateMastAngle();
          if (boatHeadingPypilotMag !== null && inputAWA !== null) outputAWA = normalizeAngle(inputAWA + mastAngle);
        },
        onBoatHeadingUpdate: (heading) => {
          boatHeadingPypilotMag = heading;
          if (VERBOSE) console.log(`Boat Heading pypilot (mag): ${radToDegree(heading).toFixed(1)}°`);
          if (canHeading !== null) updateMastAngle();
          if (canHeading !== null && inputAWA !== null) outputAWA = normalizeAngle(inputAWA + mastAngle);
        },
        onConnectionStatusChange: (source, connected) => {
          console.log(`PyPilot ${source} connection status: ${connected ? 'connected' : 'disconnected'}`);
        }
      });
      pypilot.start();
      console.log(`Mast heading source: pypilot at ${mastHost}:${pypilotPort}`);
      console.log(`Boat heading source: pypilot at ${boatHost}:${pypilotPort}`);
    }

    // ── Honeywell SSE source (--honey <hostname>) ────────────────────────
    if (USE_HONEY) {
      honey.init({
        honeyHost: argv.honey,
        honeyPort: argv.honeyPort,
        debug: DEBUG,
        verbose: VERBOSE,
        onMastAngleUpdate: (radians) => {
          const degrees = radToDegree(radians);
          mastAngleHoney = radians;
          if (VERBOSE) console.log(`Mast Angle (honey): ${degrees.toFixed(1)}°`);
          if (Math.abs(degrees) < HONEY_CENTER_THRESHOLD_DEG) {
            if (!honeyCentered) {
              honeyCentered = true;
              if (VERBOSE) console.log(`[honey] Mast centered (${degrees.toFixed(2)}°, threshold ±${HONEY_CENTER_THRESHOLD_DEG}°) — triggering auto-center`);
              api.center().then(result => {
                if (VERBOSE) console.log(`[honey] Auto-center result: ${result.message}`);
              }).catch(err => {
                console.error(`[honey] Auto-center error: ${err.message}`);
              });
            }
          } else {
            honeyCentered = false;
          }
        },
        onConnectionStatusChange: (connected) => {
          console.log(`Honey SSE connection status: ${connected ? 'connected' : 'disconnected'}`);
        }
      });
      honey.start();
      console.log(`Mast angle source: Honeywell SSE at http://${argv.honey}:${argv.honeyPort}/mast-events`);
    }

    // ── ESP32 BNO08x compass source (--esphost <hostname>) ──────────────
    if (USE_ESP) {
      espcompass.init({
        espHost: argv.esphost,
        espPort: argv.espPort,
        debug: DEBUG,
        verbose: VERBOSE,
        onBoatHeadingUpdate: (heading) => {
          boatHeadingESP = heading;
          if (VERBOSE) console.log(`Boat Heading (ESP BNO08x): ${radToDegree(heading).toFixed(1)}°`);
          if (canHeading !== null) updateMastAngle();
          if (canHeading !== null && inputAWA !== null) outputAWA = normalizeAngle(inputAWA + mastAngle);
        },
        onConnectionStatusChange: (connected) => {
          console.log(`ESP compass SSE connection status: ${connected ? 'connected' : 'disconnected'}`);
        }
      });
      espcompass.start();
      console.log(`Boat heading source: ESP32 BNO08x SSE at http://${argv.esphost}:${argv.espPort}/events`);
    }

    if (!USE_LOCAL && !USE_HONEY) {
      console.warn('WARNING: No mast heading source enabled. Use --local or --honey <host>.');
    }
    if (windChannel) windChannel.start();
    if (TRANSMIT_HEADING) {
      initHeadingTransmit();
      console.log(`Transmitting mast heading (PGN 127250) on ${headingDevice}`);
    }
    console.log(`Monitoring Wind Data (PGN 130306) on ${windCanDevice}`);
    console.log(`Heading mode: ${[USE_LOCAL ? '--local (pypilot)' : null, USE_ESP ? `--esphost ${argv.esphost}` : null, USE_HONEY ? `--honey ${argv.honey}` : null].filter(Boolean).join(' + ')}`);
    console.log(`Forwarding ${REPORT_MODE ? 'Uncorrected' : 'Corrected'} Wind Data from ${windCanDevice} to SignalK server at ${skServer}:${skPort}`);
    console.log(`Debug mode: ${DEBUG ? 'enabled' : 'disabled'} (use --debug to enable)`);
    console.log(`Verbose mode: ${VERBOSE ? 'enabled' : 'disabled'} (use --verbose to enable)`);
    console.log(`Report mode: ${REPORT_MODE ? 'enabled' : 'disabled'} (use --report to enable)`);
    console.log('Diagnostic information:');
    console.log(`- Node.js version: ${process.version}`);
    console.log(`- Platform: ${process.platform}`);
    console.log(`- SignalK connected: ${signalk.isConnected() ? 'Yes' : 'No'}`);
    if (USE_LOCAL) {
      const pypilotStatus = pypilot.isConnected();
      console.log(`- PyPilot mast connected: ${pypilotStatus.mast ? 'Yes' : 'No'}`);
      console.log(`- PyPilot boat connected: ${pypilotStatus.boat ? 'Yes' : 'No'}`);
    }
    if (USE_ESP) {
      console.log(`- ESP compass connected: ${espcompass.isConnected() ? 'Yes' : 'No'}`);
    }
    if (USE_HONEY) {
      console.log(`- Honey SSE connected: ${honey.isConnected() ? 'Yes' : 'No'}`);
    }
    console.log(`- Current mastOffset: ${mastOffset}`);
    console.log('Press Ctrl+C to exit');
  } catch (error) {
    console.error(`Failed to initialize: ${error.message}`);
    console.log('Will retry connection in 1 second...');
    setTimeout(initialize, 1000);
  }
}

function updateMastAngle() {
  // Prefer ESP compass for boat heading if available, fall back to pypilot
  const activeBoatHeading = boatHeadingESP !== null ? boatHeadingESP : boatHeadingPypilotMag;
  const activeBoatOffset  = boatHeadingESP !== null ? espOffset      : pypilotOffset;
  if (activeBoatHeading === null || canHeading === null) {
    return;
  }
  const boatCorrected = normalizeAngle(activeBoatHeading + activeBoatOffset);
  const mastCorrected = normalizeAngle(canHeading + mastHeadingOffset);

  mastAngle = calculateHeadingDifference(boatCorrected, mastCorrected);

  // True-based mast angle using RTK as reference
  if (boatHeadingRTKTrue !== null) {
    const trueHeadingDiff = calculateHeadingDifference(boatHeadingRTKTrue, mastCorrected);
    mastAngleTrue = trueHeadingDiff;
  }

  const displayMastAngle = mapAngleToDisplayRange(mastAngle);
  if (VERBOSE) {
    const src = boatHeadingESP !== null ? 'ESP' : 'pypilot';
    console.log(`boatHeading(${src}): ${radToDegree(activeBoatHeading).toFixed(1)}° mastHeading: ${radToDegree(canHeading).toFixed(1)}° mastAngle: ${radToDegree(displayMastAngle).toFixed(1)}°`);
  }
  const now = Date.now();
  const signalkWs = signalk.getWebSocket();
  const wsConnected = signalk.isConnected();
  if ((now - lastMastAngleUpdate > 100) && wsConnected && signalkWs && signalkWs.readyState === 1) { 
    try {
      const mastAngleUpdate = {
        context: 'vessels.self',
        updates: [
          {
            source: {
              label: 'pgn-monitor',
              type: 'CAN'
            },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: 'sailing.mastAngle',
                value: mapAngleToDisplayRange(mastAngle)
              }
            ]
          }
        ]
      };
      const updateJson = JSON.stringify(mastAngleUpdate);
      signalkWs.send(updateJson);
      lastMastAngleUpdate = now;
    } catch (error) {
      console.error(`Error sending mastAngle update: ${error.message}`);
    }
  }
}
const api = {
    center: async function() {
    try {
      console.log("center function");
      if (boatHeadingRTKTrue === null) {
        return {
          success: false,
          message: "Cannot center: Missing RTK true heading (reference)"
        };
      }
      // Set each offset so that raw + offset = RTK true heading
      if (boatHeadingPypilotMag !== null) {
        pypilotOffset = calculateHeadingDifference(boatHeadingPypilotMag, boatHeadingRTKTrue);
        console.log(`pypilotOffset set to ${radToDegree(pypilotOffset).toFixed(2)}°`);
      }
      if (boatHeadingESP !== null) {
        espOffset = calculateHeadingDifference(boatHeadingESP, boatHeadingRTKTrue);
        console.log(`espOffset set to ${radToDegree(espOffset).toFixed(2)}°`);
      }
      if (canHeading !== null) {
        mastHeadingOffset = calculateHeadingDifference(canHeading, boatHeadingRTKTrue);
        console.log(`mastHeadingOffset set to ${radToDegree(mastHeadingOffset).toFixed(2)}°`);
      }

      updateMastAngle();
      try {
        await saveConfig();
      } catch (fileError) {
        console.error(`Error saving config to local file: ${fileError.message}`);
      }
      return {
        success: true,
        message: "All heading offsets aligned to RTK true heading",
        pypilotOffset: pypilotOffset,
        espOffset: espOffset,
        mastHeadingOffset: mastHeadingOffset
      };
    } catch (error) {
      return {
        success: false,
        message: `Error centering: ${error.message}`
      };
    }
  },
    reset: async function() {
    try {
      mastOffset = 0;
      pypilotOffset = 0;
      espOffset = 0;
      mastHeadingOffset = 0;
      updateMastAngle();
      try {
        await saveConfig();
      } catch (fileError) {
        console.error(`Error saving reset config to local file: ${fileError.message}`);
      }
      console.log("all offsets reset");
      return {
        success: true,
        message: 'All heading offsets reset to 0'
      };
    } catch (error) {
      return {
        success: false,
        message: `Error resetting: ${error.message}`
      };
    }
  }
};
const app = express();
const PORT = process.env.MASTROT_PORT ? parseInt(process.env.MASTROT_PORT) : 3333;
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.get('/api/status', (req, res) => {
  res.json({
    mastAngleMag: mastAngle !== null ? mapAngleToDisplayRange(mastAngle) : null,
    mastAngleTrue: mastAngleTrue !== null ? mapAngleToDisplayRange(mastAngleTrue) : null,
    mastAngleHoney: mastAngleHoney !== null ? mastAngleHoney : null,
    honeyEnabled: USE_HONEY,
    mastOffset: mastOffset,
    // Raw headings
    boatHeadingPypilotMag: boatHeadingPypilotMag,
    boatHeadingESP: boatHeadingESP,
    boatHeadingRTKTrue: boatHeadingRTKTrue,
    canHeading: canHeading !== null ? canHeading : 0,
    // Corrected headings (raw + offset, aligned to RTK)
    boatHeadingPypilotCorrected: boatHeadingPypilotMag !== null ? normalizeAngle(boatHeadingPypilotMag + pypilotOffset) : null,
    boatHeadingESPCorrected: boatHeadingESP !== null ? normalizeAngle(boatHeadingESP + espOffset) : null,
    canHeadingCorrected: canHeading !== null ? normalizeAngle(canHeading + mastHeadingOffset) : null,
    // Offsets
    pypilotOffset: pypilotOffset,
    espOffset: espOffset,
    mastHeadingOffset: mastHeadingOffset,
    inputAWA: inputAWA !== null ? inputAWA : 0,
    inputAWADegrees: inputAWA !== null ? radToDegree(mapAngleToDisplayRange(inputAWA)) : 0,
    inputAWS: inputAWS !== null ? inputAWS : 0,
    outputAWA: outputAWA !== null ? outputAWA : 0,
    outputAWADegrees: outputAWA !== null ? radToDegree(mapAngleToDisplayRange(outputAWA)) : 0,
    toggleCorrect: toggleCorrect
  });
});
app.get('/api/center', async (req, res) => {
  console.log("GET center request received");
  const result = await api.center();
  res.json(result);
});
app.get('/api/reset', async (req, res) => {
  console.log("GET reset request received");
  const result = await api.reset();
  res.json(result);
});
app.get('/api/wind-correction', async (req, res) => {
  if (req.query.enabled !== undefined) {
    const enabled = req.query.enabled === 'true';
    toggleCorrect = enabled;
    console.log(`Wind correction ${enabled ? 'enabled' : 'disabled'}`);
    try {
      await saveConfig();
    } catch (error) {
      console.error(`Error saving config: ${error.message}`);
    }
  }
  res.json({
    success: true,
    enabled: toggleCorrect,
    message: `Wind correction ${toggleCorrect ? 'enabled' : 'disabled'}`
  });
});
module.exports = {
  get mastAngle() { return mastAngle; },
  get mastAngleMapped() { return mapAngleToDisplayRange(mastAngle); },
  get boatHeadingPypilotMag() { return boatHeadingPypilotMag; },
  get boatHeadingESP() { return boatHeadingESP; },
  get boatHeadingRTKTrue() { return boatHeadingRTKTrue; },
  get canHeading() { return canHeading; },
  get mastOffset() { return mastOffset; },
  set mastOffset(value) { mastOffset = value; },
  calculateHeadingDifference,
  updateMastAngle,
  normalizeAngle,
  mapAngleToDisplayRange,
  api,
  app,
  startServers: function(expressPort = PORT) {
    app.listen(expressPort, () => {
      console.log(`Express API server listening on port ${expressPort}`);
    }).on('error', (err) => {
      console.error(`Failed to start Express server: ${err.message}`);
    });
    return this;
  }
};
initialize();
if (require.main === module) {
  console.log("Starting Express server on port 3333...");
  module.exports.startServers();
  process.on('SIGINT', () => {
    console.log('Closing CAN channel, WebSocket connection, and API server...');
    if (windChannel) windChannel.stop();
    if (headingChannel) headingChannel.stop();
    if (!HEADING_ONLY) {
      const ws = signalk.getWebSocket();
      if (ws) ws.close();
    }
    process.exit(0);
  });
} else {
  process.on('SIGINT', () => {
    console.log('Closing CAN channel and WebSocket connection...');
    if (windChannel) windChannel.stop();
    if (headingChannel) headingChannel.stop();
    if (!HEADING_ONLY) {
      const ws = signalk.getWebSocket();
      if (ws) ws.close();
    }
    process.exit(0);
  });
}

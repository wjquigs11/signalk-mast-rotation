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
const argv = minimist(process.argv.slice(2), {
  string: ['wind', 'skServer', 'clientId', 'mastHost', 'boatHost'],
  boolean: ['debug', 'report'],
  default: {
    wind: 'can1',
    skServer: 'localhost',
    skPort: 3000,
    debug: false,
    report: false,
    clientId: 'mast-rotation',
    mastHost: '10.1.1.1',
    boatHost: 'localhost',
    pypilotPort: 23322
  }
});
const DEBUG = argv.debug;
const VERBOSE = argv.verbose || DEBUG; 
const REPORT_MODE = argv.report;

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
let mastAngle = null; 
let mastOffset = 0; 
let lastMastAngleUpdate = 0; 
let toggleCorrect = true; 
console.log(`Wind CAN device: ${windCanDevice}`);
console.log(`SignalK server: ${skServer}`);
console.log(`Signalk port: ${skPort}`);
let inputAWA = null;
let inputAWS = null;
let outputAWA = null;
let boatHeading = null;  
let canHeading = null;   
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
        console.log(`Wind Data: AWA=${radToDegree(inputAWA).toFixed(1)}°, AWS=${inputAWS.toFixed(1)} m/s`);
      }
      if (boatHeading !== null && canHeading !== null) {
        const previousMastAngle = mastAngle;
        updateMastAngle();
        if (previousMastAngle !== null && Math.abs(mastAngle - previousMastAngle) > 0.01) {
        }
        outputAWA = normalizeAngle(inputAWA + mastAngle);
      } else {
        outputAWA = inputAWA;
      }
      const windAngle = (toggleCorrect && outputAWA && !REPORT_MODE) ? outputAWA : (pgn.fields.windAngle || 0);
      const values = [
        {
          path: 'environment.wind.angleApparent',
          value: windAngle
        },
        {
          path: 'environment.wind.speedApparent',
          value: pgn.fields.windSpeed || 0
        },
        {
          path: 'environment.wind.angleApparentRaw',
          value: inputAWA !== null ? inputAWA : 0
        }
      ];
      if (mastAngle !== null) {
        values.push({
          path: 'sailing.mastAngle',
          value: mapAngleToDisplayRange(mastAngle)
        });
        lastMastAngleUpdate = Date.now();
      }
      signalk.forwardWindData({ 
        values,
        debug: {
          inputAWA: inputAWA,
          boatHeading: boatHeading,
          mastHeading: canHeading
        }
      });
    }
  }
});
console.log(`Opening CAN device: ${windCanDevice}`);
const windChannel = socketcan.createRawChannel(windCanDevice);
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
async function saveConfig() {
  try {
    const configFilePath = path.join(process.cwd(), 'mastrot-config.json');
    const config = {
      mastOffset: mastOffset,
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
    signalk.init({
      skServer: skServer,
      skPort: skPort,
      clientId: clientId,
      tokenFilePath: tokenFilePath,
      debug: DEBUG,
      verbose: VERBOSE,
      onBoatHeadingUpdate: null, 
      onConnectionStatusChange: (connected) => {
        console.log(`SignalK connection status: ${connected ? 'connected' : 'disconnected'}`);
      }
    });
    signalk.start();
    pypilot.init({
      mastHost: mastHost,
      boatHost: boatHost,
      pypilotPort: pypilotPort,
      debug: DEBUG,
      verbose: VERBOSE,
      onMastHeadingUpdate: (heading) => {
        canHeading = heading;
        if (VERBOSE) {
          console.log(`Mast Heading: ${radToDegree(heading).toFixed(1)}°`);
        }
        if (boatHeading !== null) {
          updateMastAngle();
        }
        if (boatHeading !== null && inputAWA !== null) {
          outputAWA = normalizeAngle(inputAWA + mastAngle);
        }
      },
      onBoatHeadingUpdate: (heading) => {
        boatHeading = heading;
        if (VERBOSE) {
          console.log(`Boat Heading: ${radToDegree(heading).toFixed(1)}°`);
        }
        if (canHeading !== null) {
          updateMastAngle();
        }
        if (canHeading !== null && inputAWA !== null) {
          outputAWA = normalizeAngle(inputAWA + mastAngle);
        }
      },
      onConnectionStatusChange: (source, connected) => {
        console.log(`PyPilot ${source} connection status: ${connected ? 'connected' : 'disconnected'}`);
      }
    });
    pypilot.start();
    windChannel.start();
    console.log(`Monitoring Wind Data (PGN 130306) on ${windCanDevice}`);
    console.log(`Monitoring Mast Heading from PyPilot at ${mastHost}:${pypilotPort}`);
    console.log(`Monitoring Boat Heading from PyPilot at ${boatHost}:${pypilotPort}`);
    console.log(`Forwarding ${REPORT_MODE ? 'Uncorrected' : 'Corrected'} Wind Data from ${windCanDevice} to SignalK server at ${skServer}:${skPort}`);
    console.log(`Debug mode: ${DEBUG ? 'enabled' : 'disabled'} (use --debug to enable)`);
    console.log(`Verbose mode: ${VERBOSE ? 'enabled' : 'disabled'} (use --verbose to enable)`);
    console.log(`Report mode: ${REPORT_MODE ? 'enabled' : 'disabled'} (use --report to enable)`);
    console.log('Diagnostic information:');
    console.log(`- Node.js version: ${process.version}`);
    console.log(`- Platform: ${process.platform}`);
    console.log(`- SignalK connected: ${signalk.isConnected() ? 'Yes' : 'No'}`);
    const pypilotStatus = pypilot.isConnected();
    console.log(`- PyPilot mast connected: ${pypilotStatus.mast ? 'Yes' : 'No'}`);
    console.log(`- PyPilot boat connected: ${pypilotStatus.boat ? 'Yes' : 'No'}`);
    console.log(`- Current mastOffset: ${mastOffset}`);
    console.log('Press Ctrl+C to exit');
  } catch (error) {
    console.error(`Failed to initialize: ${error.message}`);
    console.log('Will retry connection in 1 second...');
    setTimeout(initialize, 1000);
  }
}
function updateMastAngle() {
  if (boatHeading === null || canHeading === null) {
    return; 
  }
  const headingDiff = calculateHeadingDifference(boatHeading, canHeading);
  mastAngle = normalizeAngle(headingDiff - mastOffset);
  const displayMastAngle = mapAngleToDisplayRange(mastAngle);
  if (VERBOSE) {
    console.log(`boatHeading: ${radToDegree(boatHeading).toFixed(1)} mastHeading: ${radToDegree(canHeading).toFixed(1)} Updated Mast Angle: ${mastAngle.toFixed(4)} rad (display: ${displayMastAngle.toFixed(4)} rad / ${radToDegree(displayMastAngle).toFixed(1)}°)`);
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
      if (boatHeading === null || canHeading === null) {
        return {
          success: false,
          message: "Cannot center: Missing heading data from boat or mast"
        };
      }
      const currentDiff = calculateHeadingDifference(boatHeading, canHeading);
      mastOffset = currentDiff;
      updateMastAngle();
      try {
        await saveConfig();
      } catch (fileError) {
        console.error(`Error saving config to local file: ${fileError.message}`);
      }
      console.log(`mast angle centered at ${mastOffset}`);
      return {
        success: true,
        message: "Mast angle centered successfully",
        offset: mastOffset
      };
    } catch (error) {
      return {
        success: false,
        message: `Error centering mast angle: ${error.message}`
      };
    }
  },
    reset: async function() {
    try {
      mastOffset = 0;
      updateMastAngle();
      try {
        await saveConfig();
      } catch (fileError) {
        console.error(`Error saving reset config to local file: ${fileError.message}`);
      }
      console.log("mast angle reset");
      return {
        success: true,
        message: 'Mast rotation offset reset to 0'
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
    mastAngle: mastAngle !== null ? mapAngleToDisplayRange(mastAngle) : 0,
    mastAngleRaw: mastAngle !== null ? mastAngle : 0,
    mastAngleDegrees: mastAngle !== null ? radToDegree(mapAngleToDisplayRange(mastAngle)) : 0,
    mastOffset: mastOffset,
    boatHeading: boatHeading !== null ? boatHeading : 0,
    canHeading: canHeading !== null ? canHeading : 0,
    inputAWA: inputAWA !== null ? inputAWA : 0,
    inputAWADegrees: inputAWA !== null ? radToDegree(inputAWA) : 0,
    inputAWS: inputAWS !== null ? inputAWS : 0,
    outputAWA: outputAWA !== null ? outputAWA : 0,
    outputAWADegrees: outputAWA !== null ? radToDegree(outputAWA) : 0,
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
  get boatHeading() { return boatHeading; },
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
    windChannel.stop();
    const ws = signalk.getWebSocket();
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });
} else {
  process.on('SIGINT', () => {
    console.log('Closing CAN channel and WebSocket connection...');
    windChannel.stop();
    const ws = signalk.getWebSocket();
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });
}
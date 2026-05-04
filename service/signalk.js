const WebSocket = require('ws');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;
let signalkWs = null;
let wsConnected = false;
let authToken = null;
let skServer = 'localhost';
let skPort = 3000;
let clientId = 'mast-rotation';
let tokenFilePath = '';
let DEBUG = false;
let VERBOSE = false;
let subscribeTrue = false;
// Callbacks
let onBoatHeadingTrueUpdate = null;
let onMagneticVariationUpdate = null;
let onConnectionStatusChange = null;
/**
 * Initialize the SignalK module
 */
function init(config) {
  skServer = config.skServer || 'localhost';
  skPort = config.skPort || 3000;
  clientId = config.clientId || 'mast-rotation';
  tokenFilePath = config.tokenFilePath || path.join(process.cwd(), 'mastrot-token');
  DEBUG = config.debug || false;
  VERBOSE = config.verbose || false;
  subscribeTrue = config.subscribeTrue || false;
  onBoatHeadingTrueUpdate = config.onBoatHeadingTrueUpdate || null;
  onMagneticVariationUpdate = config.onMagneticVariationUpdate || null;
  onConnectionStatusChange = config.onConnectionStatusChange || null;
}
async function loadToken() {
  try {
    if (await fs.pathExists(tokenFilePath)) {
      const token = await fs.readFile(tokenFilePath, 'utf8');
      if (token && token.trim()) {
        console.log('Loaded authentication token from file');
        return token.trim();
      }
    }
    console.log('No saved token found');
    return null;
  } catch (error) {
    console.error(`Error loading token: ${error.message}`);
    return null;
  }
}
async function saveToken(token) {
  try {
    await fs.writeFile(tokenFilePath, token);
    console.log('Saved authentication token to file');
  } catch (error) {
    console.error(`Error saving token: ${error.message}`);
  }
}
async function requestAccessToken() {
  try {
    console.log('Requesting access token from SignalK server...');
    const response = await fetch(`http://${skServer}:${skPort}/signalk/v1/access/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: clientId,
        description: 'Mast Rotation Correction'
      })
    });
    if (response.ok) {
      const data = await response.json();
      console.log('Access request submitted. Please approve the request in the SignalK server interface.');
      console.log(`Request ID: ${data.requestId}`);
      pollForToken(data.href);
      return null;
    } else {
      console.error(`Failed to request access: ${response.status} ${response.statusText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error requesting access token: ${error.message}`);
    console.log('Will retry requesting access token in 1 second...');
    setTimeout(requestAccessToken, 1000);
    return null;
  }
}
async function pollForToken(href) {
  try {
    console.log('Checking token status...');
    const response = await fetch(`http://${skServer}:${skPort}${href}`);
    if (!response.ok) {
      console.error(`Failed to check token status: ${response.status} ${response.statusText}`);
      setTimeout(() => pollForToken(href), 5000);
      return;
    }
    const data = await response.json();
    if (data.state === 'COMPLETED') {
      if (data.accessRequest && data.accessRequest.permission === 'APPROVED') {
        console.log('Access request approved!');
        authToken = data.accessRequest.token;
        await saveToken(authToken);
        connectToSignalK();
      } else {
        console.error('Access request was denied or expired');
        setTimeout(() => requestAccessToken(), 10000);
      }
    } else {
      console.log('Access request still pending. Waiting for approval...');
      setTimeout(() => pollForToken(href), 5000);
    }
  } catch (error) {
    console.error(`Error polling for token: ${error.message}`);
    if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch')) {
      console.log('Connection issue detected, retrying in 1 second...');
      setTimeout(() => pollForToken(href), 1000);
    } else {
      setTimeout(() => pollForToken(href), 5000);
    }
  }
}
function connectToSignalK() {
  if (signalkWs && (signalkWs.readyState === WebSocket.CONNECTING || signalkWs.readyState === WebSocket.OPEN)) {
    console.log('WebSocket already connecting or connected, skipping duplicate connect');
    return;
  }
  try {
    let wsUrl = `ws://${skServer}:${skPort}/signalk/v1/stream?subscribe=none`;
    if (authToken) {
      wsUrl += `&token=${authToken}`;
    }
    wsUrl = wsUrl.replace('?subscribe=none&token=', '?token=');
    console.log(`Connecting to SignalK WebSocket at ${wsUrl}`);
    signalkWs = new WebSocket(wsUrl);
    console.log('WebSocket connection attempt started');
    signalkWs.on('open', () => {
      console.log('Connected to SignalK WebSocket');
      wsConnected = true;
      if (onConnectionStatusChange) {
        onConnectionStatusChange(true);
      }
      console.log('WebSocket state after connection:', {
        readyState: signalkWs.readyState,
        bufferedAmount: signalkWs.bufferedAmount,
        url: signalkWs.url
      });
      setTimeout(() => {
        if (signalkWs.readyState === WebSocket.OPEN) {
          sendMetadata();
          sendSubscriptions();
        } else {
          console.error(`WebSocket not ready: readyState ${signalkWs.readyState}`);
        }
      }, 1000);
    });
    signalkWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.updates) {
          for (const update of msg.updates) {
            processSignalKData(update);
          }
        }
        if (DEBUG) console.log('SignalK message:', JSON.stringify(msg));
      } catch (error) {
        console.error('Error parsing SignalK message:', error.message);
      }
    });
    signalkWs.on('error', (error) => {
      console.error(`SignalK WebSocket error: ${error.message}`);
      console.error('Error details:', error);
      wsConnected = false;
      if (onConnectionStatusChange) {
        onConnectionStatusChange(false);
      }
    });
    signalkWs.on('close', () => {
      console.log('SignalK WebSocket connection closed');
      wsConnected = false;
      if (onConnectionStatusChange) {
        onConnectionStatusChange(false);
      }
      setTimeout(() => {
        if (!wsConnected) {
          console.log('Attempting to reconnect to SignalK...');
          connectToSignalK();
        }
      }, 1000);
    });
  } catch (error) {
    console.error(`Error connecting to SignalK: ${error.message}`);
    wsConnected = false;
    if (onConnectionStatusChange) {
      onConnectionStatusChange(false);
    }
    setTimeout(() => {
      if (!wsConnected) {
        console.log('Attempting to reconnect to SignalK...');
        connectToSignalK();
      }
    }, 1000);
  }
}
async function sendMetadata() {
  try {
    const response = await fetch(`http://${skServer}:${skPort}/signalk/v1/api/vessels/self/sailing/mastAngle/meta`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify({
        units: 'rad',
        description: 'Mast rotation angle correction (difference between boat heading and mast heading)',
        displayName: 'Mast Angle'
      })
    });
    if (response.ok) {
      console.log('Sent metadata for mastAngle path');
    } else {
      console.log(`Metadata PUT returned ${response.status} - continuing anyway`);
    }
  } catch (error) {
    console.log(`Metadata PUT failed: ${error.message} - continuing anyway`);
  }
}
function sendSubscriptions() {
  const paths = [{ path: 'environment.wind.*', period: 1000, format: 'delta', policy: 'instant' }];
  if (subscribeTrue) paths.push({ path: 'navigation.headingTrue', period: 1000, format: 'delta', policy: 'instant' });
  // Subscribe to magnetic variation at once per minute
  paths.push({ path: 'navigation.magneticVariation', period: 60000, format: 'delta', policy: 'instant' });

  const subscriptionMsg = { context: 'vessels.self', subscribe: paths };
  try {
    const subscriptionJson = JSON.stringify(subscriptionMsg);
    console.log('Sending subscription message:', subscriptionJson);
    if (signalkWs && signalkWs.readyState === WebSocket.OPEN) {
      signalkWs.send(subscriptionJson);
      console.log('Subscribed to SignalK paths');
    } else {
      console.error('WebSocket not ready for sending subscription');
    }
  } catch (error) {
    console.error('Error sending subscription:', error.message);
  }
}
function processSignalKData(update) {
  if (!update.values || !Array.isArray(update.values)) {
    return;
  }
  for (const value of update.values) {
    if (value.path === 'navigation.headingTrue' && value.value !== undefined) {
      if (onBoatHeadingTrueUpdate) onBoatHeadingTrueUpdate(value.value);
    }
    if (value.path === 'navigation.magneticVariation' && value.value !== undefined) {
      if (onMagneticVariationUpdate) onMagneticVariationUpdate(value.value);
    }
  }
}
async function forwardWindData(windData) {
  try {
    if (!wsConnected || !signalkWs || signalkWs.readyState !== WebSocket.OPEN) {
      return;
    }
    const deltaUpdate = {
      context: 'vessels.self',
      updates: [
        {
          source: {
            label: 'pgn-monitor',
            type: 'CAN'
          },
          timestamp: new Date().toISOString(),
          values: windData.values
        }
      ]
    };
    const deltaJson = JSON.stringify(deltaUpdate);
    if (DEBUG) {
      console.log('Using delta format for updates:');
      console.log(JSON.stringify(deltaUpdate, null, 2));
    }
    const radToDeg = (rad) => rad !== null ? (rad * 180 / Math.PI).toFixed(1) : 'null';
    const radToDegSigned = (rad) => {
      if (rad === null) return 'null';
      let deg = rad * 180 / Math.PI;
      if (deg > 180) deg -= 360;
      return deg.toFixed(1);
    };
    if (VERBOSE) {
      console.log(`Sending delta update to SignalK | AWA: ${radToDegSigned(windData.debug.inputAWA)}° | Boat: ${radToDeg(windData.debug.boatHeading)}° | Mast: ${radToDeg(windData.debug.mastHeading)}°`);
    }
    if (DEBUG) {
      console.log('WebSocket readyState:', signalkWs.readyState);
      console.log('WebSocket bufferedAmount:', signalkWs.bufferedAmount);
    }
    try {
      if (typeof deltaJson === 'string') {
        signalkWs.send(deltaJson);
      } else {
        signalkWs.send(JSON.stringify(deltaUpdate));
      }
    } catch (error) {
      console.error(`Error sending update: ${error.message}`);
      wsConnected = false;
      if (onConnectionStatusChange) {
        onConnectionStatusChange(false);
      }
    }
  } catch (error) {
    console.error(`Error in forwardWindData: ${error.message}`);
  }
}
async function start() {
  authToken = await loadToken();
  // Close any existing connection (may have been opened without a token)
  if (signalkWs && (signalkWs.readyState === WebSocket.OPEN || signalkWs.readyState === WebSocket.CONNECTING)) {
    signalkWs.removeAllListeners('close'); // prevent auto-reconnect loop
    signalkWs.close();
    signalkWs = null;
    wsConnected = false;
  }
  if (authToken) {
    connectToSignalK();
  } else {
    await requestAccessToken();
  }
}
function isConnected() {
  return wsConnected;
}
function getWebSocket() {
  return signalkWs;
}
module.exports = {
  init,
  start,
  isConnected,
  getWebSocket,
  forwardWindData,
  loadToken,
  saveToken
};

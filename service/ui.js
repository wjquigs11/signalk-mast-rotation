#!/usr/bin/env node
const express = require('express');
const path = require('path');
const minimist = require('minimist');
const fetch = require('node-fetch');

const argv = minimist(process.argv.slice(2), {
  boolean: ['verbose'],
  default: {
    port: 3030,
    apiHost: 'localhost',
    apiPort: 3333,
    verbose: false
  }
});

const UI_PORT = argv.port;
const API_BASE = `http://${argv.apiHost}:${argv.apiPort}/api`;
const VERBOSE = argv.verbose;

const app = express();

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  require('fs').createReadStream(path.join(__dirname, 'ui.html')).pipe(res);
});

app.get('/api-config', (req, res) => {
  // Always route browser through this server's proxy so --verbose logging works
  res.json({ apiBase: '/api' });
});

// Proxy /api/* to mastrot API with optional verbose logging
app.use('/api', async (req, res) => {
  const url = `${API_BASE}${req.url}`;
  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    if (VERBOSE) {
      console.log(`[${new Date().toISOString()}] GET ${url}`);
      console.log(JSON.stringify(data, null, 2));
    }
    res.json(data);
  } catch (err) {
    console.error(`Proxy error for ${url}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.use(express.static(__dirname));

app.listen(UI_PORT, () => {
  console.log(`Mastrot UI running in ${__dirname}`);
  console.log(`Mastrot UI server listening on port ${UI_PORT}`);
  console.log(`API base: ${API_BASE}`);
  console.log(`Verbose: ${VERBOSE}`);
});

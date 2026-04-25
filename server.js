const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// CORS - allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('public'));

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function extractPDF(buffer) {
  const b64 = buffer.toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `Eres asistente de extraccion de datos para un restaurante espanol.
Recibes una factura o albaran de proveedor en PDF.
Extrae proveedor, fecha y TODOS los productos con cantidad, unidad y precio unitario.
Responde UNICAMENTE con JSON valido. Sin texto previo ni posterior. Sin markdown.
Formato exacto:
{"proveedor":"...","fecha":"YYYY-MM-DD","numero_doc":"...","items":[{"nombre":"...","cantidad":1.0,"unidad":"kg","precio_unitario":0.0}]}
Si no encuentras un campo usa cadena vacia o 0.`,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: 'Extrae todos los productos de esta factura. Solo JSON.' }
        ]
      }]
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error('Claude API: ' + data.error.message);
  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No se encontro JSON en la respuesta');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.items)) parsed.items = [];
  return parsed;
}

async function callAppsScript(payload) {
  if (!APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL no configurada');
  const resp = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch(e) { return { status: 'ok', raw: text }; }
}

app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibio archivo PDF' });
    const extracted = await extractPDF(req.file.buffer);
    res.json({ ok: true, data: extracted, filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/confirmar', async (req, res) => {
  try {
    const { items, proveedor, fecha, numero_doc } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Sin items' });
    const result = await callAppsScript({ type: 'entrada', items, proveedor, fecha, numero_doc });
    res.json({ ok: true, message: items.length + ' producto(s) registrados en Google Sheets', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/salida', async (req, res) => {
  try {
    const { nombre, tipo, cantidad, unidad, fecha, nota } = req.body;
    if (!nombre || !cantidad) return res.status(400).json({ error: 'Faltan datos' });
    const result = await callAppsScript({ type: 'salida', nombre, tipo, cantidad, unidad, fecha, nota });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/productos', async (req, res) => {
  try {
    const result = await callAppsScript({ type: 'get_productos' });
    res.json({ ok: true, productos: result.productos || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'Chalet Suizo Inventario API', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));

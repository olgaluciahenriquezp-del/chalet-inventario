const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static('public'));

// ── GOOGLE SHEETS AUTH ──
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ── EXTRACT PDF WITH CLAUDE ──
async function extractPDF(buffer) {
  const b64 = buffer.toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `Eres asistente de extracción de datos para un restaurante español.
Recibes una factura o albarán de proveedor en PDF.
Extrae proveedor, fecha y TODOS los productos con cantidad, unidad y precio unitario.
Responde ÚNICAMENTE con JSON válido. Sin texto previo ni posterior. Sin markdown.
Formato exacto:
{"proveedor":"...","fecha":"YYYY-MM-DD","numero_doc":"...","items":[{"nombre":"...","cantidad":1.0,"unidad":"kg","precio_unitario":0.0}]}
Si no encuentras un campo usa cadena vacía o 0.`,
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
  if (data.error) throw new Error(`Claude API: ${data.error.message}`);
  const raw = data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No se encontró JSON en la respuesta');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.items)) parsed.items = [];
  return parsed;
}
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Load .env (if present and not already set via --env-file) ─────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
}

// ── Config ────────────────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC  = path.join(__dirname, 'public');
const MODEL   = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

if (!API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

// ── MIME map for static file serving ─────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.ico' : 'image/x-icon',
  '.png' : 'image/png',
};

// ── OpenAI client ─────────────────────────────────────────────────────────────
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: API_KEY });

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert software architect and diagramming specialist. \
Your sole task is to analyze images of hand-drawn or whiteboard architecture sketches \
and convert them into valid Mermaid diagram syntax.

Rules:
1. Output ONLY a fenced Mermaid code block — no prose, no explanation, no commentary before or after.
2. Choose the most appropriate Mermaid diagram type for the sketch:
   - flowchart TD / LR  →  general flowcharts, architecture with directional flow
   - sequenceDiagram     →  request/response or time-ordered interactions between components
   - classDiagram        →  class hierarchies, domain models, OOP structures
   - graph               →  network topology, infra maps with no clear direction
   - erDiagram           →  entity-relationship / data models
   - stateDiagram-v2     →  state machines
3. Preserve the visual semantics of the sketch:
   - rounded rectangles → frontend("Frontend")
   - rectangles         → frontend["Frontend"]
   - circles / ovals    → db(("DB"))
   - database cylinders → db[("DB")]
   - diamonds           → decision{"Decision?"}
4. Preserve arrow semantics:
   - one-way arrows     → frontend --> backend
   - bidirectional      → frontend <--> backend
   - undirected lines   → frontend --- backend
   - dashed lines       → frontend -.-> backend or frontend -.- backend
   - thick arrows       → frontend ==> backend
   - If both connector ends visibly have arrowheads, always use <-->.
   - Do not infer arrow direction from the node layout, hierarchy, or reading order; use only the visible arrowheads.
   - If one arrowhead is unclear but the line appears symmetric between architecture components, prefer <--> over -->.
5. Use safe Mermaid node IDs and separate them from visible labels:
   - IDs must start with a letter and contain only letters, numbers, and underscores.
   - Never use a raw label as an ID if it starts with a number or contains spaces, punctuation, or quotes.
   - For labels such as "3PL", define a safe node like three_pl["3PL"], then connect three_pl.
   - Define each shaped node once, then use only its ID in edges.
6. Preserve the intent and labels visible in the sketch as closely as possible; clean up obvious spelling errors.
7. If the sketch is ambiguous, produce the most reasonable interpretation as a flowchart TD.
8. Every node label must be valid Mermaid syntax — wrap labels with special characters in quotes.
9. Never truncate the output; always produce the full diagram.

Flowchart syntax example:
\`\`\`mermaid
flowchart TD
  frontend("Frontend")
  backend("Backend")
  db(("DB"))
  three_pl["3PL"]
  frontend <--> backend
  backend <--> db
  backend --> three_pl
\`\`\`

Output format (strictly):
\`\`\`mermaid
<diagram content here>
\`\`\``;

const DIAGRAM_TYPES = {
  auto: 'choose the most appropriate Mermaid diagram type for the sketch',
  flowchart: 'use a Mermaid flowchart, choosing TD or LR based on the sketch direction',
  sequenceDiagram: 'use Mermaid sequenceDiagram syntax',
  classDiagram: 'use Mermaid classDiagram syntax',
  'stateDiagram-v2': 'use Mermaid stateDiagram-v2 syntax',
  erDiagram: 'use Mermaid erDiagram syntax',
  gantt: 'use Mermaid gantt syntax',
  journey: 'use Mermaid journey syntax',
  pie: 'use Mermaid pie syntax',
  quadrantChart: 'use Mermaid quadrantChart syntax',
  timeline: 'use Mermaid timeline syntax',
  mindmap: 'use Mermaid mindmap syntax',
  gitGraph: 'use Mermaid gitGraph syntax',
};

// ── Helper: read request body ─────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── Helper: send JSON response ────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type'  : 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── POST /convert ─────────────────────────────────────────────────────────────
async function handleConvert(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: 'Invalid JSON body' });
  }

  const { imageBase64, mimeType } = body;
  const requestedDiagramType = typeof body.diagramType === 'string' ? body.diagramType : 'auto';
  const diagramInstruction   = DIAGRAM_TYPES[requestedDiagramType];

  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return sendJSON(res, 400, { error: 'imageBase64 is required' });
  }
  if (!diagramInstruction) {
    return sendJSON(res, 400, { error: 'Unsupported Mermaid diagram type.' });
  }
  if (!ALLOWED_TYPES.includes(mimeType)) {
    return sendJSON(res, 400, { error: `Unsupported image type: ${mimeType}. Use JPEG, PNG, GIF, or WEBP.` });
  }
  // base64 of 5 MB ≈ 6.8 MB of characters
  if (imageBase64.length > 7_000_000) {
    return sendJSON(res, 413, { error: 'Image exceeds 5 MB limit.' });
  }

  try {
    const response = await client.responses.create({
      model            : MODEL,
      instructions     : SYSTEM_PROMPT,
      max_output_tokens: 4096,
      reasoning        : { effort: 'high' },
      input            : [
        {
          role   : 'user',
          content: [
            {
              type     : 'input_image',
              image_url: `data:${mimeType};base64,${imageBase64}`,
              detail   : 'high',
            },
            {
              type: 'input_text',
              text: `Convert this sketch to Mermaid diagram syntax. Diagram type preference: ${diagramInstruction}. Output only the fenced mermaid code block.`,
            },
          ],
        },
      ],
    });

    const rawText = response.output_text ?? '';
    const match   = rawText.match(/```mermaid\s*([\s\S]*?)\s*```/);
    const mermaid = match ? match[1].trim() : rawText.trim();

    return sendJSON(res, 200, { mermaid });
  } catch (err) {
    console.error('OpenAI API error:', err);
    const status  = err.status ?? 500;
    const message = err.message ?? 'API call failed';
    return sendJSON(res, status >= 400 && status < 600 ? status : 500, { error: message });
  }
}

// ── Static file server ────────────────────────────────────────────────────────
function handleStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // Prevent path traversal
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== PUBLIC) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext  = path.extname(filePath);
  const mime = MIME[ext] ?? 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type'  : mime,
      'Cache-Control' : 'no-store',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/convert' || req.url.startsWith('/convert?')) {
    return handleConvert(req, res);
  }

  handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`MermaSketch running at http://localhost:${PORT}`);
});

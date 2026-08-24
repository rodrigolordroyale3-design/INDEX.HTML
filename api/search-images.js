const https = require('https');
const http = require('http');

// Utilitário para fazer requisições HTTP
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        ...options.headers
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Busca no OpenFoodFacts / OpenProductsFacts / OpenBeautyFacts
async function searchOpenFacts(barcode) {
  if (!barcode) return [];
  const bases = [
    `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
    `https://world.openproductsfacts.org/api/v2/product/${barcode}.json`,
    `https://world.openbeautyfacts.org/api/v2/product/${barcode}.json`
  ];
  const results = [];
  for (const url of bases) {
    try {
      const res = await fetchUrl(url);
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.status === 1 && data.product) {
          const p = data.product;
          const imageUrl = p.image_front_url || p.image_url;
          if (imageUrl) {
            results.push({
              url: imageUrl,
              title: p.product_name || barcode,
              source: 'OpenFacts',
              provider: 'openfacts',
              score: 90
            });
          }
        }
      }
    } catch (e) {}
  }
  return results;
}

// Busca no Bing Images
async function searchBing(query) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://www.bing.com/images/async?q=${encoded}&first=1&count=12&mmasync=1`;
    const res = await fetchUrl(url, {
      headers: {
        'Referer': 'https://www.bing.com/images/search?q=' + encoded
      }
    });
    if (res.status !== 200) return [];
    const results = [];
    const regex = /"murl":"(https?:\/\/[^"]+?)"/g;
    const titleRegex = /"t":"([^"]+?)"/g;
    let match, titleMatch;
    const titles = [];
    while ((titleMatch = titleRegex.exec(res.body)) !== null) {
      titles.push(titleMatch[1]);
    }
    let i = 0;
    while ((match = regex.exec(res.body)) !== null) {
      const imgUrl = match[1];
      if (imgUrl.match(/\.(jpg|jpeg|png|webp)/i)) {
        results.push({
          url: imgUrl,
          title: titles[i] || query,
          source: 'Bing',
          provider: 'bing',
          score: 0
        });
        i++;
        if (results.length >= 8) break;
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

// Busca no DuckDuckGo Images
async function searchDuckDuckGo(query) {
  try {
    const encoded = encodeURIComponent(query);
    // Passo 1: obter token
    const tokenRes = await fetchUrl(`https://duckduckgo.com/?q=${encoded}&iax=images&ia=images`);
    const tokenMatch = tokenRes.body.match(/vqd=([\d-]+)/);
    if (!tokenMatch) return [];
    const vqd = tokenMatch[1];
    // Passo 2: buscar imagens
    const imgRes = await fetchUrl(
      `https://duckduckgo.com/i.js?q=${encoded}&vqd=${vqd}&p=1&s=0&u=bing&f=,,,&l=pt-br`,
      { headers: { 'Referer': 'https://duckduckgo.com/' } }
    );
    if (imgRes.status !== 200) return [];
    const data = JSON.parse(imgRes.body);
    return (data.results || []).slice(0, 8).map(r => ({
      url: r.image,
      title: r.title,
      source: 'DuckDuckGo',
      provider: 'duckduckgo',
      score: 0
    }));
  } catch (e) {
    return [];
  }
}

// Calcula score de confiança
function calculateScore(result, barcode, description) {
  let score = result.score || 0;
  if (result.provider === 'openfacts') return Math.max(90, score);

  const text = (result.title + ' ' + result.url).toLowerCase();
  const desc = (description || '').toLowerCase();
  const words = desc.split(/\s+/).filter(w => w.length >= 4);

  // Código de barras no resultado
  if (barcode && text.includes(barcode)) score += 50;

  // Palavras da descrição encontradas
  let matchCount = 0;
  for (const word of words) {
    if (text.includes(word)) matchCount++;
  }
  if (words.length > 0) {
    score += Math.round((matchCount / words.length) * 40);
  }

  return Math.min(score, 89);
}

// Gera queries de busca
function buildQueries(barcode, description) {
  const queries = [];
  if (barcode) queries.push(barcode);
  if (description) queries.push(description);
  if (barcode && description) queries.push(`${barcode} ${description}`);
  // Query com primeiras palavras (marca + produto)
  if (description) {
    const parts = description.split(' ').slice(0, 3).join(' ');
    if (!queries.includes(parts)) queries.push(parts + ' foto produto');
  }
  return queries;
}

// Handler principal
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { barcode, description } = req.method === 'POST'
    ? await new Promise(resolve => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => resolve(JSON.parse(body || '{}')));
      })
    : req.query;

  if (!barcode && !description) {
    return res.status(400).json({ error: 'Informe barcode ou description' });
  }

  try {
    let allResults = [];

    // 1. OpenFacts (melhor fonte para código de barras)
    if (barcode) {
      const factsResults = await searchOpenFacts(barcode);
      allResults.push(...factsResults);
    }

    // 2. Bing + DuckDuckGo com queries em cascata
    const queries = buildQueries(barcode, description);
    for (const query of queries.slice(0, 2)) {
      const [bingResults, ddgResults] = await Promise.all([
        searchBing(query),
        searchDuckDuckGo(query)
      ]);
      allResults.push(...bingResults, ...ddgResults);
      if (allResults.length >= 12) break;
    }

    // 3. Calcula scores
    allResults = allResults.map(r => ({
      ...r,
      score: calculateScore(r, barcode, description)
    }));

    // 4. Remove duplicatas e ordena por score
    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    unique.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      results: unique.slice(0, 24),
      best: unique[0] || null
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

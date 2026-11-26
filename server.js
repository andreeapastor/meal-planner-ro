const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Memorează modelul și setarea rapidă care au funcționat, pentru răspuns instant la click-urile următoare
let cachedFastConfig = null;

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

function buildGenerationConfig(thinkingMode, maxOutputTokens) {
  const config = {
    temperature: 0.6,
    maxOutputTokens,
    responseMimeType: 'application/json'
  };

  if (thinkingMode === 'level_minimal') {
    config.thinkingConfig = { thinkingLevel: 'minimal' };
  } else if (thinkingMode === 'budget_zero') {
    config.thinkingConfig = { thinkingBudget: 0 };
  }

  return config;
}

async function callGemini(model, prompt, apiKey, thinkingMode, maxOutputTokens) {
  const cleanModel = model.replace(/^models\//, '');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: buildGenerationConfig(thinkingMode, maxOutputTokens)
      })
    }
  );

  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

async function discoverFlashModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    if (!data.models) return [];

    return data.models
      .filter(
        (m) =>
          m.supportedGenerationMethods?.includes('generateContent') &&
          m.name.includes('flash') &&
          !m.name.includes('image') &&
          !m.name.includes('audio') &&
          !m.name.includes('tts')
      )
      .map((m) => m.name.replace(/^models\//, ''));
  } catch {
    return [];
  }
}

app.post('/api/generate', async (req, res) => {
  const startTime = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'Lipsește variabila GEMINI_API_KEY în setările Render.'
    });
  }

  const { mode, homeIngredients, shoppingList, strictMode, preferences } = req.body;

  if (!homeIngredients || homeIngredients.length === 0) {
    return res.status(400).json({
      error: 'Adaugă cel puțin un ingredient în lista „Ce am acasă”.'
    });
  }

  const homeListText = homeIngredients.join(', ');
  const neededListText = shoppingList && shoppingList.length > 0 ? shoppingList.join(', ') : 'nimic';
  const prefText = preferences ? `Preferințe: ${preferences}.` : '';
  const strictText = strictMode
    ? 'REGULĂ STRICTĂ: Folosește DOAR ingredientele de acasă (+ apă, sare, piper, ulei). Fără cumpărături.'
    : 'Folosește prioritar ce este acasă, dar poți adăuga ingrediente uzuale de cumpărat.';

  let prompt = '';
  let maxTokens = 1400;

  if (mode === 'recipes') {
    maxTokens = 1400;
    prompt = `Bucătar român. Propune 3 preparate gustoase pentru 2 PERSOANE, în română, foarte concis.
Acasă: ${homeListText}. Pe listă: ${neededListText}. ${strictText} ${prefText}
JSON strict:
{
  "recipes": [
    {
      "title": "Nume preparat",
      "mealType": "Mic dejun / Prânz / Cină",
      "prepTime": "25 min",
      "servings": "2 persoane",
      "ingredientsFromHome": ["cantitate + ingredient"],
      "missingIngredients": ["cantitate + ingredient lipsă sau []"],
      "steps": ["Pas 1 scurt.", "Pas 2 scurt.", "Pas 3 scurt."]
    }
  ]
}`;
  } else if (mode === 'week') {
    maxTokens = 3200;
    prompt = `Nutriționist român. Plan alimentar pe 7 ZILE (Luni-Duminică) pentru 2 PERSOANE, în română, foarte concis.
Acasă: ${homeListText}. Pe listă: ${neededListText}. ${strictText} ${prefText}
JSON strict:
{
  "days": [
    {
      "day": "Luni",
      "breakfast": { "name": "Nume (2 porții)", "ingredients": ["cantitate + ingredient"], "instructions": "1 propoziție scurtă." },
      "lunch": { "name": "Nume (2 porții)", "ingredients": ["cantitate + ingredient"], "instructions": "1 propoziție scurtă." },
      "dinner": { "name": "Nume (2 porții)", "ingredients": ["cantitate + ingredient"], "instructions": "1 propoziție scurtă." }
    }
  ],
  "shoppingList": ["cantitate + ingredient lipsă de cumpărat"]
}`;
  } else {
    return res.status(400).json({ error: 'Mod invalid.' });
  }

  try {
    let result = null;

    // 1. Dacă avem deja combinația rapidă salvată, o apelăm direct într-un singur pas
    if (cachedFastConfig) {
      result = await callGemini(
        cachedFastConfig.model,
        prompt,
        apiKey,
        cachedFastConfig.thinkingMode,
        maxTokens
      );
      if (!result.ok) {
        cachedFastConfig = null; // Resetăm dacă modelul a devenit indisponibil temporar
      }
    }

    // 2. La prima rulare, găsim cea mai rapidă combinație și o salvăm în memorie
    if (!result || !result.ok) {
      const candidateModels = ['gemini-3.8-flash', 'gemini-3.8-flash-lite'];
      const thinkingModes = ['level_minimal', 'budget_zero', 'none'];

      for (const model of candidateModels) {
        for (const tMode of thinkingModes) {
          result = await callGemini(model, prompt, apiKey, tMode, maxTokens);
          if (result.ok) {
            cachedFastConfig = { model, thinkingMode: tMode };
            break;
          }
          // Dacă modelul nu există (404) sau e supraîncărcat (503/429), trecem la următorul model
          if (result.status !== 400) break;
        }
        if (result && result.ok) break;
      }

      // Dacă niciunul din cele două nu a mers, căutăm dinamic alte modele Flash disponibile
      if (!result || !result.ok) {
        const discovered = await discoverFlashModels(apiKey);
        for (const model of discovered) {
          if (candidateModels.includes(model)) continue;
          result = await callGemini(model, prompt, apiKey, 'none', maxTokens);
          if (result.ok) {
            cachedFastConfig = { model, thinkingMode: 'none' };
            break;
          }
        }
      }
    }

    if (!result || !result.ok) {
      if (result?.status === 503 || result?.status === 429) {
        return res.status(503).json({
          error: 'Serverele gratuite Google AI sunt momentan aglomerate. Mai apasă o dată în câteva secunde.'
        });
      }
      const apiMsg = result?.data?.error?.message || 'Eroare la comunicarea cu Gemini AI.';
      return res.status(result?.status || 500).json({ error: apiMsg });
    }

    const rawText = result.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.status(500).json({ error: 'AI-ul nu a returnat niciun răspuns.' });
    }

    const cleanedJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanedJson);

    console.log(`Generat (${mode}) în ${((Date.now() - startTime) / 1000).toFixed(2)}s folosind ${cachedFastConfig?.model}`);
    return res.json(parsed);
  } catch (err) {
    console.error('Eroare server:', err);
    return res.status(500).json({
      error: 'A apărut o eroare la procesare. Încearcă din nou.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serverul rulează pe portul ${PORT}`);
});

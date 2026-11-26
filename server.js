const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(model, prompt, apiKey) {
  const cleanModel = model.replace(/^models\//, '');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

async function getFallbackModels(apiKey, excludeModel) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    if (!data.models) return [];

    return data.models
      .filter(
        (m) =>
          m.supportedGenerationMethods?.includes('generateContent') &&
          m.name.includes('flash') &&
          !m.name.includes(excludeModel) &&
          !m.name.includes('image') &&
          !m.name.includes('audio') &&
          !m.name.includes('tts')
      )
      .map((m) => m.name.replace(/^models\//, ''))
      .slice(0, 3);
  } catch {
    return [];
  }
}

app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Lipsește variabila GEMINI_API_KEY în setările Render (Environment Variables).'
    });
  }

  const { mode, homeIngredients, shoppingList, strictMode, preferences } = req.body;

  if (!homeIngredients || homeIngredients.length === 0) {
    return res.status(400).json({
      error: 'Adaugă cel puțin un ingredient în lista „Ce am acasă” înainte de a genera.'
    });
  }

  const homeListText = homeIngredients.join(', ');
  const neededListText = shoppingList && shoppingList.length > 0 ? shoppingList.join(', ') : 'nimic specificat';
  const prefText = preferences ? `Preferințe suplimentare: ${preferences}.` : '';
  const strictText = strictMode
    ? 'REGULĂ STRICTĂ: Folosește DOAR ingredientele din lista "Ce am acasă" (plus apă, sare, piper, ulei de bază). Nu adăuga alte ingrediente de cumpărat.'
    : 'Folosește prioritar ingredientele din "Ce am acasă" pentru a reduce risipa, dar poți completa rețetele cu ingrediente uzuale care trebuie cumpărate.';

  let prompt = '';

  if (mode === 'recipes') {
    prompt = `Ești un bucătar profesionist român. Creează 4 idei de preparate delicioase pentru EXACT 2 PERSOANE, în limba română.
Ingrediente disponibile acasă: ${homeListText}.
Ingrediente deja pe lista de cumpărături: ${neededListText}.
${strictText}
${prefText}

Răspunde STRICT în format JSON valid cu următoarea structură:
{
  "recipes": [
    {
      "title": "Numele preparatului",
      "mealType": "Mic dejun / Prânz / Cină",
      "prepTime": "ex: 30 min",
      "servings": "2 persoane",
      "ingredientsFromHome": ["cantitate + ingredient existent acasă"],
      "missingIngredients": ["cantitate + ingredient care lipsește (listă goală [] dacă nu lipsește nimic)"],
      "steps": [
        "Pasul 1 clar și concis...",
        "Pasul 2..."
      ]
    }
  ]
}`;
  } else if (mode === 'week') {
    prompt = `Ești un nutriționist și bucătar român. Creează un plan alimentar complet pe 7 ZILE (Luni - Duminică) pentru EXACT 2 PERSOANE, în limba română.
Ingrediente disponibile acasă: ${homeListText}.
Ingrediente deja pe lista de cumpărături: ${neededListText}.
${strictText}
${prefText}

Asigură varietate pe parcursul săptămânii și calculează toate cantitățile pentru 2 porții.
Răspunde STRICT în format JSON valid cu următoarea structură:
{
  "days": [
    {
      "day": "Luni",
      "breakfast": {
        "name": "Nume mic dejun (2 porții)",
        "ingredients": ["cantitate + ingredient"],
        "instructions": "Mod de preparare scurt (2-3 propoziții)."
      },
      "lunch": {
        "name": "Nume prânz (2 porții)",
        "ingredients": ["cantitate + ingredient"],
        "instructions": "Mod de preparare scurt (2-3 propoziții)."
      },
      "dinner": {
        "name": "Nume cină (2 porții)",
        "ingredients": ["cantitate + ingredient"],
        "instructions": "Mod de preparare scurt (2-3 propoziții)."
      }
    }
  ],
  "shoppingList": [
    "cantitate totală + ingredient care NU este în lista de acasă și trebuie cumpărat pentru acest plan"
  ]
}`;
  } else {
    return res.status(400).json({ error: 'Mod invalid.' });
  }

  try {
    const primaryModel = 'gemini-3.8-flash';
    let result = await callGemini(primaryModel, prompt, apiKey);

    // Reîncearcă o dată dacă serverul Google e temporar supraîncărcat (503)
    if (!result.ok && (result.status === 503 || result.status === 429)) {
      await sleep(2000);
      result = await callGemini(primaryModel, prompt, apiKey);
    }

    // Dacă tot e supraîncărcat, încearcă automat alte modele Flash gratuite disponibile
    if (!result.ok && (result.status === 503 || result.status === 429)) {
      const fallbacks = await getFallbackModels(apiKey, primaryModel);
      for (const fallbackModel of fallbacks) {
        result = await callGemini(fallbackModel, prompt, apiKey);
        if (result.ok) break;
      }
    }

    if (!result.ok) {
      if (result.status === 503 || result.status === 429) {
        return res.status(503).json({
          error: 'Serverele gratuite Google AI sunt momentan aglomerate. Mai apasă o dată pe buton în câteva secunde.'
        });
      }
      const apiMsg = result.data?.error?.message || 'Eroare la comunicarea cu Gemini AI.';
      return res.status(result.status).json({ error: apiMsg });
    }

    const rawText = result.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.status(500).json({ error: 'AI-ul nu a returnat niciun răspuns.' });
    }

    const cleanedJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanedJson);

    return res.json(parsed);
  } catch (err) {
    console.error('Eroare server:', err);
    return res.status(500).json({
      error: 'A apărut o eroare la procesarea răspunsului AI. Încearcă din nou.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serverul rulează pe portul ${PORT}`);
});

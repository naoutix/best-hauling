import { test, expect } from "@playwright/test";

// Tests de fumée : chaque scénario encode un bug passé -> non-régression.
// L'app est un module ES (état non global), donc on pilote surtout via l'UI/DOM.

// Playwright isole le contexte (localStorage/hash) par test : on part toujours propre.
// On ne vide PAS via addInitScript (qui se relancerait à chaque reload et effacerait
// les corrections, stockées uniquement en localStorage — d'où l'intérêt du test de persistance).
test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
});

test("l'app charge et affiche des routes", async ({ page }) => {
  expect(await page.locator("#rows tr").count()).toBeGreaterThan(50);
  await expect(page.locator("#rows tr").first().locator(".score-cell")).toBeVisible();
});

test("navigation entre les cinq vues", async ({ page }) => {
  await page.click("#viewLoops");
  await expect(page.locator("#loops")).toBeVisible();
  await page.click("#viewEnroute");
  await expect(page.locator("#enrouteControls")).toBeVisible();
  await page.click("#viewChain");
  await expect(page.locator("#chainControls")).toBeVisible();
  await page.click("#viewCorrections");
  await expect(page.locator("#correctionsControls")).toBeVisible();
  // les contrôles En route ne doivent PAS fuir hors de leur vue (bug [hidden]/flex)
  await expect(page.locator("#enrouteControls")).toBeHidden();
  await page.click("#viewRoutes");
  await expect(page.locator("#routes")).toBeVisible();
});

test("le vaisseau ET sa carte (image) sont restaurés au rechargement (régression)", async ({ page }) => {
  await page.fill("#ship", "railen");
  await page.locator("#shipList li").first().click();
  await expect(page.locator("#shipCard")).toBeVisible();
  await expect(page.locator("#ship")).toHaveValue(/Railen/i);

  await page.reload();
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await expect(page.locator("#ship")).toHaveValue(/Railen/i);          // nom restauré
  await expect(page.locator("#shipCard")).toBeVisible();               // carte réaffichée (le bug)
  await expect(page.locator("#shipImg")).toHaveAttribute("src", /^https:\/\//); // src d'image posé
});

test("capStock : une demande corrigée à 0 met les unités à 0 (régression)", async ({ page }) => {
  await page.check("#capStock");
  const result = await page.evaluate(async () => {
    const span = document.querySelector('#rows tr .editv[data-s="sell"][data-f="vol"]');
    const c = span.dataset.c, t = span.dataset.t;
    span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const inp = span.querySelector("input");
    inp.value = "0";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const s2 = [...document.querySelectorAll('#rows .editv[data-s="sell"][data-f="vol"]')]
      .find((s) => s.dataset.c === c && s.dataset.t === t);
    const row = s2.closest("tr");
    return { demand: s2.textContent, units: row.querySelectorAll("td.num")[2].textContent.trim() };
  });
  expect(result.demand).toContain("0");
  expect(result.units).toBe("0"); // demande corrigée à 0 = pas de demande -> 0 unité
});

test("correction locale : marqueur ✎, compteur, et persistance au rechargement", async ({ page }) => {
  const span = page.locator('#rows tr:first-child .editv[data-s="buy"][data-f="price"]');
  await span.click();
  await span.locator("input").fill("4321");
  await span.locator("input").press("Enter");
  await expect(page.locator("#viewCorrections")).toHaveText(/Corrections \(1\)/);

  await page.reload();
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await expect(page.locator("#viewCorrections")).toHaveText(/Corrections \(1\)/); // persistée
  await expect(page.locator("#rows .editv.ov").first()).toBeVisible();            // marqueur conservé
});

test("le schéma de trajet se déplie puis se replie", async ({ page }) => {
  await page.locator("#rows tr:first-child .route-toggle").click();
  await expect(page.locator("#rows tr.schema-row .schema")).toBeVisible();
  await expect(page.locator("#rows tr.schema-row .schema-leg")).toHaveCount(2);
  await page.locator("#rows tr:first-child .route-toggle").click();
  await expect(page.locator("#rows tr.schema-row")).toHaveCount(0);
});

test("vue Corrections : rechercher une station affiche ses commodités éditables", async ({ page }) => {
  await page.click("#viewCorrections");
  await page.fill("#station", "Levski — Nyx");
  await expect(page.locator("#correctionsStation .station-table tbody tr").first()).toBeVisible();
  expect(await page.locator("#correctionsStation .editv").count()).toBeGreaterThan(0);
});

test("les filtres s'appliquent aux bonnes vues — légales uniquement (régression câblage)", async ({ page }) => {
  // Trajets : « légales uniquement » retire les routes de commodités illégales (souvent en tête de marge).
  const routesAll = await page.locator("#rows tr").count();
  await page.check("#legalOnly");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  const routesLegal = await page.locator("#rows tr").count();
  expect(routesLegal).toBeLessThan(routesAll);
  await page.uncheck("#legalOnly");

  // Boucles : le filtre doit aussi agir (<= car une boucle illégale n'est pas garantie en tête).
  await page.click("#viewLoops");
  const loopsAll = await page.locator("#loopRows tr").count();
  await page.check("#legalOnly");
  const loopsLegal = await page.locator("#loopRows tr").count();
  expect(loopsLegal).toBeLessThanOrEqual(loopsAll);
  await page.uncheck("#legalOnly");

  // Commodités : LE bug d'origine — « légales uniquement » doit masquer les commodités illégales.
  await page.click("#viewCommodities");
  await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible();
  const commAll = await page.locator("#commGrid .comm-tile").count();
  await page.check("#legalOnly");
  const commLegal = await page.locator("#commGrid .comm-tile").count();
  expect(commLegal).toBeLessThan(commAll);
  await page.uncheck("#legalOnly");
});

test("Chaîne : le filtre « même système » contraint la chaîne (régression)", async ({ page }) => {
  await page.click("#viewChain");
  await expect(page.locator("#chainControls")).toBeVisible();
  const origin = await page.locator("#originList option").first().getAttribute("value");
  await page.fill("#chainOrigin", origin);
  await expect(page.locator("#chainOut .chain-leg").first()).toBeVisible();
  // Avec « même système », tous les badges système de la chaîne doivent être identiques.
  await page.check("#sameSystem");
  await expect(page.locator("#chainOut .chain-leg").first()).toBeVisible();
  const systems = await page.locator("#chainOut .chain-leg .sys").allInnerTexts();
  expect(new Set(systems.map((s) => s.trim())).size).toBeLessThanOrEqual(1);
});

test("En route : destination forçable + ajout/retrait libre au manifeste", async ({ page }) => {
  await page.click("#viewEnroute");
  await expect(page.locator("#destTerminal")).toBeVisible(); // Feature 1 : champ « terminal d'arrivée »
  const origin = await page.locator("#originList option").first().getAttribute("value");
  await page.fill("#origin", origin);
  await expect(page.locator("#manifest")).toBeVisible();
  // Si un manifeste avec lignes existe, teste l'ajout LIBRE d'une commodité + le retrait (Feature 2).
  if (await page.locator("#manifestAddInput").count()) {
    const have = await page.locator("#manifest .mname").allInnerTexts();
    const opts = await page.locator("#commodityList option").evaluateAll((els) => els.map((e) => e.value));
    const toAdd = opts.find((o) => !have.some((h) => h.includes(o)));
    const before = await page.locator("#manifest .mline").count();
    await page.fill("#manifestAddInput", toAdd);
    await page.click("#manifestAddBtn");
    await expect(page.locator("#manifest .mline")).toHaveCount(before + 1);
    await page.locator("#manifest .mline-del").last().click();
    await expect(page.locator("#manifest .mline")).toHaveCount(before);
  }
  // Forcer un terminal d'arrivée précis ne casse pas le rendu du manifeste.
  const term = await page.locator("#stationList option").first().getAttribute("value");
  await page.fill("#destTerminal", term);
  await expect(page.locator("#manifest")).toBeVisible();
});

test("Compagnon de voyage : sélectionner un trajet affiche le parcours", async ({ page }) => {
  // Avant sélection : l'invite « démarrer un voyage » est affichée (plus d'étapes).
  await expect(page.locator("#journeyStartBtn")).toBeVisible();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(0);
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard")).toBeVisible();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2); // 2 stations pour 1 saut
  await expect(page.locator("#journeyCard .jstep.here")).toHaveCount(1);
  await page.locator("#journeyClear").click();
  // Après effacement : retour à l'invite de démarrage.
  await expect(page.locator("#journeyStartBtn")).toBeVisible();
});

test("Compagnon de voyage : sélectionner un trajet pré-remplit En route (départ/arrivée)", async ({ page }) => {
  const row = page.locator("#rows tr").first();
  const buyTerminal = (await row.locator(".term-name").nth(0).innerText()).trim();
  const sellTerminal = (await row.locator(".term-name").nth(1).innerText()).trim();
  await row.locator(".journey-pick").click();
  // Les champs En route sont pré-remplis avec la jambe courante.
  expect(await page.inputValue("#origin")).toContain(buyTerminal);
  expect(await page.inputValue("#destTerminal")).toContain(sellTerminal);
  // La vue En route affiche bien un manifeste vers la station d'arrivée.
  await page.click("#viewEnroute");
  await expect(page.locator("#manifest")).toContainText(sellTerminal);
});

test("Compagnon de voyage : pré-remplit Chaîne + remonte les boucles depuis l'arrivée", async ({ page }) => {
  // Chaîne : chainOrigin = station de départ courante.
  const row = page.locator("#rows tr").first();
  const buyTerminal = (await row.locator(".term-name").nth(0).innerText()).trim();
  await row.locator(".journey-pick").click();
  expect(await page.inputValue("#chainOrigin")).toContain(buyTerminal);

  // Boucles : sélectionne une route qui arrive sur un terminal de boucle -> les from-here remontent.
  await page.click("#viewLoops");
  const loopSet = new Set((await page.locator("#loopRows .term-name").allInnerTexts()).map((t) => t.trim()));
  await page.click("#viewRoutes");
  const routes = page.locator("#rows tr");
  const count = Math.min(await routes.count(), 60);
  let matched = false;
  for (let i = 0; i < count; i++) {
    const sell = (await routes.nth(i).locator(".term-name").nth(1).innerText()).trim();
    if (loopSet.has(sell)) { await routes.nth(i).locator(".journey-pick").click(); matched = true; break; }
  }
  if (matched) {
    await page.click("#viewLoops");
    expect(await page.locator("#loopRows tr.from-here").count()).toBeGreaterThan(0);
    await expect(page.locator("#loopRows tr").first()).toHaveClass(/from-here/); // pertinentes en tête
  }
});

test("Compagnon de voyage : cliquer une étape recale En route (position interactive)", async ({ page }) => {
  const row = page.locator("#rows tr").first();
  const buyTerminal = (await row.locator(".term-name").nth(0).innerText()).trim();
  const sellTerminal = (await row.locator(".term-name").nth(1).innerText()).trim();
  await row.locator(".journey-pick").click();
  expect(await page.inputValue("#origin")).toContain(buyTerminal); // au départ
  // Clique la station d'arrivée -> « je suis là » -> En route repart de l'arrivée.
  await page.locator("#journeyCard .jstep").nth(1).click();
  await expect(page.locator("#journeyCard .jstep").nth(1)).toHaveClass(/here/);
  expect(await page.inputValue("#origin")).toContain(sellTerminal);
});

test("Compagnon de voyage : étendre le parcours avec une boucle depuis l'arrivée", async ({ page }) => {
  await page.click("#viewLoops");
  const loopSet = new Set((await page.locator("#loopRows .term-name").allInnerTexts()).map((t) => t.trim()));
  await page.click("#viewRoutes");
  const routes = page.locator("#rows tr");
  const count = Math.min(await routes.count(), 60);
  let matched = false;
  for (let i = 0; i < count; i++) {
    const sell = (await routes.nth(i).locator(".term-name").nth(1).innerText()).trim();
    if (loopSet.has(sell)) { await routes.nth(i).locator(".journey-pick").click(); matched = true; break; }
  }
  test.skip(!matched, "aucune route vers un terminal de boucle dans le jeu de données");
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2); // 1 saut = 2 stations
  await page.click("#viewLoops");
  await page.locator("#loopRows tr.from-here").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(4); // + boucle (2 sauts) = 3 sauts, 4 stations
});

test("Compagnon de voyage : le parcours survit au rechargement (persistance)", async ({ page }) => {
  const row = page.locator("#rows tr").first();
  const sellTerminal = (await row.locator(".term-name").nth(1).innerText()).trim();
  await row.locator(".journey-pick").click();
  await expect(page.locator("#journeyCard")).toBeVisible();
  await page.reload();
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await expect(page.locator("#journeyCard")).toBeVisible();             // restauré
  await expect(page.locator("#journeyCard")).toContainText(sellTerminal);
});

test("Compagnon de voyage : manifeste optimal affiché par jambe", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jleg")).toHaveCount(1);
  // Le manifeste (cargaison) se calcule (MARKET chargé à la demande).
  await expect(page.locator("#journeyCard .jleg .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#journeyCard .jleg-profit").first()).toContainText("+");
  // Chaque matériau porte un indicateur de fraîcheur des données (pastille colorée).
  await expect(page.locator("#journeyCard .jcargo-item .fresh-dot").first()).toBeVisible();
  await expect(page.locator("#journeyCard .jcargo-item .fresh-dot")).toHaveCount(
    await page.locator("#journeyCard .jcargo-item").count()
  );
});

test("Compagnon de voyage : les commodités transportées sont surlignées dans le board", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await page.click("#viewCommodities");
  await expect(page.locator("#commGrid .comm-tile.carried")).not.toHaveCount(0); // au moins une surlignée
  await expect(page.locator("#commGrid .comm-tile.carried .tile-carried").first()).toBeVisible();
});

test("Compagnon de voyage : ajouter un arrêt (suggestion) étend le parcours", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstop-suggest").first()).toBeVisible({ timeout: 8000 });
  const stopsBefore = await page.locator("#journeyCard .jstep").count();
  await page.locator("#journeyCard .jstop-suggest").first().click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(stopsBefore + 1);
});

test("Compagnon de voyage : retirer un arrêt du milieu reconnecte le parcours", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstop-suggest").first()).toBeVisible({ timeout: 8000 });
  await page.locator("#journeyCard .jstop-suggest").first().click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(3); // 3 arrêts
  const first = (await page.locator("#journeyCard .jstep").nth(0).innerText()).trim();
  const last = (await page.locator("#journeyCard .jstep").nth(2).innerText()).trim();
  await page.locator("#journeyCard .jstep-del").nth(1).click(); // retire le milieu
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2); // reconnecté A->C
  expect((await page.locator("#journeyCard .jstep").nth(0).innerText()).trim()).toBe(first);
  expect((await page.locator("#journeyCard .jstep").nth(1).innerText()).trim()).toBe(last);
});

test("Compagnon de voyage : éditer le manifeste d'une jambe (SCU) persiste hors lien", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await page.locator("#journeyCard .jleg-head").first().click();          // déplie l'éditeur
  await expect(page.locator("#journeyCard .jman")).toBeVisible();
  await page.locator("#journeyCard .jman-qty").first().fill("7");
  await page.locator("#journeyCard .jman-qty").first().blur();
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1);  // ✎ = manifeste personnalisé
  // Les édits sont en localStorage, pas dans l'URL (lien léger).
  expect(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits"))).toBeTruthy();
  expect(page.url()).not.toContain("Aluminum");
  await page.reload();
  await expect(page.locator("#journeyCard .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1);  // édits restaurés
});

test("Compagnon de voyage : on peut ajouter n'importe quel arrêt (même sans fret rentable)", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
  // Attend le chargement du marché (suggestions ou message vide).
  await expect(page.locator("#journeyCard .jstop-suggest, #journeyCard .journey-suggest-empty").first()).toBeVisible({ timeout: 8000 });
  // Ajoute un terminal NON suggéré, par NOM SEUL (sans « — Système »).
  const sug = new Set(await page.locator("#journeyCard .jstop-suggest").evaluateAll((els) => els.map((e) => e.dataset.label)));
  const opts = await page.locator("#stationList option").evaluateAll((els) => els.map((e) => e.value));
  const notSuggested = opts.find((o) => !sug.has(o));
  await page.fill("#journeyAddStop", notSuggested.split(" — ")[0]);
  await page.click("#journeyAddBtn");
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(3); // ajouté quoi qu'il arrive
});

test("Compagnon de voyage : démarrer un voyage « de zéro » (sans passer par un trajet)", async ({ page }) => {
  // L'invite « Nouveau voyage » est visible dès le départ, sans avoir cliqué ▶.
  await expect(page.locator("#journeyStartBtn")).toBeVisible();
  await expect(page.locator("#journeyCard .journey-title")).toHaveText(/Nouveau voyage/);
  // Focus le champ -> précharge le marché -> le datalist se peuple.
  await page.locator("#journeyStart").focus();
  await expect
    .poll(async () => page.locator("#stationList option").count(), { timeout: 8000 })
    .toBeGreaterThan(0);
  const first = await page.locator("#stationList option").first().getAttribute("value");
  // Démarre depuis ce terminal (par nom seul).
  await page.fill("#journeyStart", first.split(" — ")[0]);
  await page.click("#journeyStartBtn");
  // Voyage « de zéro » : une seule station, pas encore de jambe, champ d'ajout présent.
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(1);
  await expect(page.locator("#journeyCard .jleg")).toHaveCount(0);
  await expect(page.locator("#journeyAddStop")).toBeVisible();
  // Ajoute un arrêt -> le parcours s'étend à 2 stations.
  const opts = await page.locator("#stationList option").evaluateAll((els) => els.map((e) => e.value));
  await page.fill("#journeyAddStop", opts.find((o) => o !== first));
  await page.click("#journeyAddBtn");
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
});

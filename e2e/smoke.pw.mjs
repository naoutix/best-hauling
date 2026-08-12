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

test("une capacité de vente inconnue s'affiche « n.c. », jamais « — »", async ({ page }) => {
  // « — » se lisait « aucune demande » alors qu'UEX ne renseigne simplement pas `scu_sell` sur
  // la plupart des points : aucun plafond n'est appliqué dans ce cas.
  const vols = page.locator('#rows .editv[data-s="sell"][data-f="vol"]');
  expect(await vols.count()).toBeGreaterThan(0);
  const textes = await vols.allTextContents();
  expect(textes.some((t) => t.trim() === "—")).toBe(false);

  const nc = page.locator("#rows .editv.nc").first();
  test.skip(!(await nc.count()), "aucune capacité inconnue dans le jeu de données");
  await expect(nc).toHaveText("n.c.");
  await expect(nc).toHaveAttribute("title", /non communiquée par UEX/);
  await expect(nc).toHaveAttribute("data-v", ""); // pas la chaîne "null" : le champ number la rejetterait
  // …et reste corrigeable comme n'importe quelle autre valeur.
  await nc.click();
  await expect(nc.locator("input")).toBeVisible();
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
  // Le récap du voyage (colonne de gauche) affiche profit total + KPIs.
  await expect(page.locator("#journeyRecap")).toBeVisible();
  await expect(page.locator("#journeyRecap .recap-profit")).toContainText("aUEC");
  await expect(page.locator("#journeyRecap .recap-kpi")).toHaveCount(4);
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

test("Multi commodité : « avec les simples » remet les trajets à une commodité dans le classement", async ({ page }) => {
  const simples = page.locator("#rows tr .cname").filter({ hasText: /^1 commodité$/ });
  await expect(page.locator("#multiModeField")).toBeHidden(); // réglage de la coche : caché sans elle
  await page.check("#multiCommodity");
  await expect(page.locator("#multiModeField")).toBeVisible();
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await expect(simples).toHaveCount(0); // par défaut : chargements combinés seulement
  await page.selectOption("#multiMode", "all");
  await expect(simples.first()).toBeVisible(); // les deux sortes, dans le MÊME classement
  expect(page.url()).toContain("multiMode=all");
  await page.reload();
  await expect(page.locator("#multiMode")).toHaveValue("all"); // le mode survit au rechargement
  await expect(page.locator("#multiModeField")).toBeVisible();
});

// ---------- Carte Manifeste (« En route ») -> jambe de voyage ----------
// Ouvre « En route » sur un terminal de départ donné et attend que la carte Manifeste soit peinte.
async function manifesteDepuis(page, label) {
  await page.click("#viewEnroute");
  await page.fill("#origin", label);
  await expect(page.locator("#manifest .manifest-head")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#manifest .mqty-input").first()).toBeVisible();
}
// Les noms d'étape sont mis en capitales par le CSS : on compare donc sans tenir compte de la casse.
const memeStation = (nom) => new RegExp(nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
// Parcours encodé dans le lien partageable (paramètre `j` du hash), ou null.
const lienVoyage = (page) => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("j"));

test("Manifeste -> voyage : sans voyage, le bouton en démarre un", async ({ page }) => {
  await manifesteDepuis(page, "Megumi — Pyro");
  await expect(page.locator("#manifestToJourney")).toHaveText(/Démarrer un voyage/);
  await page.click("#manifestToJourney");
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
  await expect(page.locator("#journeyCard .jleg")).toHaveCount(1);
  await expect(page.locator("#journeyCard .jstep").nth(0)).toHaveText(memeStation("Megumi"));
  // La carte confirme sur place : le bouton cède la place à la phrase, à l'endroit du clic.
  await expect(page.locator("#manifest .journey-hint")).toHaveText(/déjà la jambe 1/);
  await expect(page.locator("#manifestToJourney")).toHaveCount(0);
});

test("Manifeste -> voyage : la jambe COURANTE n'offre pas de bouton (non-destruction)", async ({ page }) => {
  // LE test qui compte : après un ▶, En route est pré-rempli avec la jambe courante. Sans garde,
  // un clic passait par la branche REMPLACER d'addToJourney et réduisait le voyage à cette jambe.
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
  await page.click("#viewEnroute");
  await expect(page.locator("#manifest")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#manifestToJourney")).toHaveCount(0);
  await expect(page.locator("#manifest .journey-hint")).toHaveText(/déjà la jambe 1/);
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2); // le voyage n'a pas bougé
});

test("Manifeste -> voyage : un départ étranger au parcours nomme les deux bouts, sans agir", async ({ page }) => {
  await manifesteDepuis(page, "Megumi — Pyro");
  await page.click("#manifestToJourney");
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
  const fin = (await page.locator("#journeyCard .jstep").nth(1).innerText()).trim();
  await page.fill("#origin", "Rod's Fuel — Pyro"); // ne part ni de la fin, ni d'une jambe planifiée
  await expect(page.locator("#manifest .journey-hint")).toContainText("Rod's Fuel");
  await expect(page.locator("#manifest .journey-hint")).toContainText(memeStation(fin));
  await expect(page.locator("#manifestToJourney")).toHaveCount(0);
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2); // aucune modification du voyage
});

test("Manifeste -> voyage : un chargement AJUSTÉ part tel quel (et hors du lien)", async ({ page }) => {
  await manifesteDepuis(page, "Megumi — Pyro");
  const qty = page.locator("#manifest .mqty-input").first();
  const nom = await page.locator("#manifest .mline-del").first().getAttribute("data-name");
  await qty.fill("13");
  await qty.blur();
  await page.click("#manifestToJourney");
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1); // ✎ = manifeste personnalisé
  await expect(page.locator("#journeyCard .jleg-cargo").first()).toContainText(`${nom} 13 SCU`);
  const edits = JSON.parse(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2")));
  expect(edits[Object.keys(edits)[0]]).toContainEqual({ name: nom, units: 13 });
  // Le lien ne transporte que le PARCOURS : la jambe y tient en 8 champs, sans aucun SCU.
  const legs = JSON.parse(await lienVoyage(page)).l;
  expect(legs[0]).toHaveLength(8);
  expect(legs.flat()).not.toContain(13);
});

test("Manifeste -> voyage : un chargement INTACT ne persiste rien (la jambe suit le marché)", async ({ page }) => {
  await manifesteDepuis(page, "Megumi — Pyro");
  await page.click("#manifestToJourney");
  await expect(page.locator("#journeyCard .jleg")).toHaveCount(1);
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(0); // pas de ✎ à tort
  const edits = await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2"));
  expect(Object.keys(JSON.parse(edits || "{}"))).toHaveLength(0);
});

// Corrige une valeur éditable de la carte Manifeste et rend l'ancienne valeur.
async function corrige(page, champ, cote, valeur) {
  const cell = page.locator(`#manifest .editv[data-f='${champ}'][data-s='${cote}']`).first();
  const avant = await cell.getAttribute("data-v");
  await cell.click();
  await page.locator("#manifest .editv-input").first().fill(String(valeur));
  await page.keyboard.press("Enter");
  return avant;
}
const profitJambe = (page) => page.locator("#journeyCard .jleg-profit").first();

test("Corrections : un PRIX corrigé met à jour les bénéfices du voyage en cours", async ({ page }) => {
  await manifesteDepuis(page, "Megumi — Pyro");
  await page.click("#manifestToJourney");
  await expect(page.locator("#journeyCard .jleg")).toHaveCount(1);
  const avant = (await profitJambe(page).innerText()).trim();
  const cargo = (await page.locator("#journeyCard .jleg-cargo").first().innerText()).trim();

  const prix = await corrige(page, "price", "sell", Math.round(Number(await page.locator("#manifest .editv[data-f='price'][data-s='sell']").first().getAttribute("data-v")) * 1.5));
  expect(Number(prix)).toBeGreaterThan(0);
  // Avant : la carte Voyage restait hors du cycle de rendu et gardait le profit d'avant.
  await expect(profitJambe(page)).not.toHaveText(avant);
  expect((await page.locator("#journeyCard .jleg-cargo").first().innerText()).trim()).toBe(cargo); // un prix ne rebat pas les SCU
  await expect(page.locator("#journeyCard .jleg-pinned")).toHaveCount(0); // et ne fige rien
});

test("Corrections : un STOCK corrigé fige la jambe engagée, mais pas les trajets suivants", async ({ page }) => {
  await manifesteDepuis(page, "Megumi — Pyro");
  await page.click("#manifestToJourney");
  await expect(page.locator("#journeyCard .jleg")).toHaveCount(1);
  const cargo = (await page.locator("#journeyCard .jleg-cargo").first().innerText()).trim();
  const nom = await page.locator("#manifest .mline-del").first().getAttribute("data-name");

  await corrige(page, "vol", "buy", 3); // « j'ai vidé la station en chargeant »
  // Le trajet est décidé : ses SCU ne rétrécissent pas sous les pieds du joueur.
  await expect(page.locator("#journeyCard .jleg-pinned")).toHaveCount(1);
  expect((await page.locator("#journeyCard .jleg-cargo").first().innerText()).trim()).toBe(cargo);
  expect(await page.evaluate(() => localStorage.getItem("best-hauling-journey-pins"))).toContain("true");

  // ...mais un chargement calculé APRÈS coup, lui, ne voit plus que ce qui reste.
  await page.fill("#origin", "Megumi — Pyro");
  await expect(page.locator("#manifest .mqty-input").first()).toBeVisible();
  const ligne = page.locator("#manifest .mline", { hasText: nom }).first();
  if (await ligne.count()) await expect(ligne.locator(".mqty-input")).toHaveValue(/^[0-3]$/);

  // « ↺ optimal » lève le gel : la jambe redevient branchée sur le marché.
  await page.locator("#journeyCard .jleg-head").first().click();
  await page.locator("#journeyCard .jman-reset").click();
  await expect(page.locator("#journeyCard .jleg-pinned")).toHaveCount(0);
  expect((await page.locator("#journeyCard .jleg-cargo").first().innerText()).trim()).not.toBe(cargo);
});

test("Compagnon de voyage : retirer l'arrivée d'un parcours à DEUX arrêts garde le départ", async ({ page }) => {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
  const depart = (await page.locator("#journeyCard .jstep").nth(0).innerText()).trim();
  await page.locator("#journeyCard .jstep-del").nth(1).click(); // ✕ sur l'arrivée
  // Avant le correctif : les DEUX arrêts disparaissaient, le voyage revenait à « Nouveau voyage ».
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(1);
  expect((await page.locator("#journeyCard .jstep").nth(0).innerText()).trim()).toBe(depart);
  // Le survivant est un vrai point de départ : il propose des arrêts et en accepte un.
  await expect(page.locator("#journeyCard .jstop-suggest").first()).toBeVisible({ timeout: 8000 });
  await page.locator("#journeyCard .jstop-suggest").first().click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(2);
  expect((await page.locator("#journeyCard .jstep").nth(0).innerText()).trim()).toBe(depart);
});

test("Compagnon de voyage : une suggestion filtrée par la vue n'est jamais proposée", async ({ page }) => {
  // Bug : « Commodités légales uniquement » coché, la boîte proposait quand même une destination
  // atteignable seulement via une commodité illégale (Megumi → Devlin Scrap via WiDoW). L'arrêt
  // s'ajoutait, et sa jambe s'affichait « aucun fret rentable » — une route qui n'existait nulle part.
  await page.check("#legalOnly");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jstop-suggest").first()).toBeVisible({ timeout: 8000 });
  await page.locator("#journeyCard .jstop-suggest").first().click();
  await expect(page.locator("#journeyCard .jstep")).toHaveCount(3);
  // La jambe ajoutée porte un vrai chargement, et aucune jambe n'est vide.
  await expect(page.locator("#journeyCard .jleg").last().locator(".jcargo-item").first()).toBeVisible();
  await expect(page.locator("#journeyCard .jleg-cargo", { hasText: "aucun fret rentable" })).toHaveCount(0);
  // Et rien d'illégal n'a pu s'inviter dans le voyage.
  await expect(page.locator("#journeyCard .jcargo-item .illegal")).toHaveCount(0);
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
  expect(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2"))).toBeTruthy();
  expect(page.url()).not.toContain("Aluminum");
  await page.reload();
  await expect(page.locator("#journeyCard .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1);  // édits restaurés
});

// Déplie l'éditeur de la 1re jambe et vide les SCU de chaque ligne (1 SCU) pour libérer la soute,
// quel que soit le manifeste optimal du jour -> il reste forcément de la place à suggérer.
async function openLegEditorWithFreeSpace(page) {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await page.locator("#journeyCard .jleg-head").first().click();
  await expect(page.locator("#journeyCard .jman")).toBeVisible();
  const qty = page.locator("#journeyCard .jman-qty");
  for (let i = 0; i < (await qty.count()); i++) await qty.nth(i).fill("1");
  await qty.first().blur();
}

test("Compagnon de voyage : libérer des SCU dans une jambe propose de quoi remplir", async ({ page }) => {
  await openLegEditorWithFreeSpace(page);
  // Même sans commodité rentable, l'en-tête annonce les SCU libres (le message diffère).
  const box = page.locator("#journeyCard .jman-suggest");
  await expect(box.locator(".suggest-head")).toContainText(/SCU libres/);

  const add = box.locator(".suggest-add").first();
  test.skip(!(await box.locator(".suggest-add").count()), "aucune commodité rentable à suggérer sur cette jambe");

  // Le bouton annonce combien de SCU il ajoute -> la ligne créée porte ce tonnage.
  const units = (await add.innerText()).replace(/\D/g, "");
  const before = await page.locator("#journeyCard .jman-line").count();
  const name = await add.getAttribute("data-name");
  await add.click();
  await expect(page.locator("#journeyCard .jman-line")).toHaveCount(before + 1);
  const added = page.locator("#journeyCard .jman-line").last();
  await expect(added.locator(".jman-name")).toContainText(name);
  await expect(added.locator(".jman-qty")).toHaveValue(units);
  // La cargaison de la jambe (repliée) reflète l'ajout, et l'édit est persisté hors URL.
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2"))).toContain(name);
});

// Encode la décision de conception : le rafraîchissement est incrémental (handler `input`), pas un
// renderJourney() — sinon l'input perdrait le focus à chaque caractère saisi.
test("Compagnon de voyage : les suggestions d'une jambe suivent la frappe sans voler le focus", async ({ page }) => {
  await openLegEditorWithFreeSpace(page);
  const box = page.locator("#journeyCard .jman-suggest");
  const qty = page.locator("#journeyCard .jman-qty").first();
  await expect(box.locator(".suggest-head")).toContainText(/SCU libres/);
  const avant = await box.locator(".suggest-head").innerText();

  // Saisie au clavier, sans blur : les SCU libres doivent suivre AVANT validation.
  await qty.focus();
  await qty.press("Control+a");
  await qty.pressSequentially("42");
  await expect(box.locator(".suggest-head")).not.toHaveText(avant);
  expect(await page.evaluate(() => document.activeElement?.classList.contains("jman-qty"))).toBe(true);
});

test("En route : les suggestions de remplissage restent rendues (non-régression du partage avec le voyage)", async ({ page }) => {
  // Passe par ▶ : ça pré-remplit départ/arrivée avec une route réelle -> manifeste garanti,
  // là où le 1er terminal du datalist n'a pas forcément de chargement rentable.
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await page.click("#viewEnroute");
  await expect(page.locator("#manifest .mqty-input").first()).toBeVisible({ timeout: 8000 });

  await page.locator("#manifest .mqty-input").first().fill("1");
  const box = page.locator("#manifestSuggest");
  await expect(box.locator(".suggest-head")).toContainText(/SCU libres/);
  test.skip(!(await box.locator(".suggest-add").count()), "aucune commodité rentable à suggérer");
  const before = await page.locator("#manifest .mline").count();
  await box.locator(".suggest-add").first().click();
  await expect(page.locator("#manifest .mline")).toHaveCount(before + 1);
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

test("mode Butin : le board expose les commodités qu'on ne peut pas acheter", async ({ page }) => {
  await page.click("#viewCommodities");
  await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible();
  // Marché : que de l'échangeable, donc aucune tuile « introuvable à l'achat ».
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBe(0);
  const nMarket = await page.locator("#commGrid .comm-tile").count();

  await page.click('#commBoardModes button[data-board="loot"]');
  expect(await page.locator("#commGrid .comm-tile").count()).toBeGreaterThan(nMarket);
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBeGreaterThan(0);
  await expect(page.locator('#commSortModes button[data-sort="margin"]')).toHaveText("Revente");

  await page.click('#commBoardModes button[data-board="market"]');
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBe(0);
});

test("mode Butin : le détail ne montre que la revente", async ({ page }) => {
  await page.click("#viewCommodities");
  await page.click('#commBoardModes button[data-board="loot"]');
  await page.locator("#commGrid .comm-tile.sell-only").first().click();
  await expect(page.locator("#commDetail .loot-value")).toBeVisible();   // prix au SCU en tête
  await expect(page.locator("#commDetail .comm-col")).toHaveCount(1);    // une seule colonne
  await expect(page.locator("#commDetail")).toContainText("Où l'écouler");
  await expect(page.locator("#commDetail")).not.toContainText("Où acheter");

  // Retour en Marché : la sélection « butin » n'existe plus, le rendu retombe sur la 1re tuile.
  await page.click('#commBoardModes button[data-board="market"]');
  await expect(page.locator("#commDetail .comm-col")).toHaveCount(2);
  await expect(page.locator("#commDetail .loot-value")).toHaveCount(0);
});

test("le mode Butin survit au rechargement (permalien)", async ({ page }) => {
  await page.click("#viewCommodities");
  await page.click('#commBoardModes button[data-board="loot"]');
  await expect(page.locator('#commBoardModes button[data-board="loot"]')).toHaveClass(/active/);

  await page.reload();
  await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible();
  await expect(page.locator('#commBoardModes button[data-board="loot"]')).toHaveClass(/active/);
  await expect(page.locator('#commSortModes button[data-sort="margin"]')).toHaveText("Revente");
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBeGreaterThan(0);
});

// ---------- Régressions du mode Butin (PR #37) ----------

test("Butin : deux tuiles ne portent jamais la même étiquette (code UEX non unique)", async ({ page }) => {
  // UEX attribue le même code à des commodités distinctes (COPP = Copper ET Copper (Ore)).
  // Invariant indépendant des données : une étiquette de tuile identifie sa commodité.
  await page.click("#viewCommodities");
  // `allInnerTexts()` n'attend RIEN : sans ces deux attentes il lit la grille avant l'arrivée de
  // market.json et le test devient fragile sous charge (il passait seul, échouait en parallèle).
  await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible({ timeout: 10000 });
  await page.click('#commBoardModes button[data-board="loot"]');
  await expect(page.locator("#commGrid .comm-tile.sell-only").first()).toBeVisible({ timeout: 10000 });
  const labels = await page.locator("#commGrid .comm-tile .tile-code").allInnerTexts();
  expect(labels.length).toBeGreaterThan(50);
  expect(new Set(labels).size).toBe(labels.length);
});

test("Butin : une commodité au code ambigu reste atteignable par son nom", async ({ page }) => {
  await page.click("#viewCommodities");
  await page.click('#commBoardModes button[data-board="loot"]');
  // Prend une commodité de butin et vérifie que cliquer sa tuile ouvre BIEN la sienne.
  const tile = page.locator("#commGrid .comm-tile.sell-only").first();
  const name = await tile.getAttribute("data-name");
  await tile.click();
  await expect(page.locator("#commDetail .comm-detail-title")).toContainText(name);
});

test("Butin : ajouter un fret trouvé n'invente ni la quantité ni un achat sur place", async ({ page }) => {
  // Récupère une commodité réellement introuvable à l'achat (tuile pointillée du board Butin).
  await page.click("#viewCommodities");
  await page.click('#commBoardModes button[data-board="loot"]');
  const loot = await page.locator("#commGrid .comm-tile.sell-only").first().getAttribute("data-name");
  expect(loot).toBeTruthy();

  // Manifeste réel via ▶ (garantit des lignes), puis ajout libre de ce fret.
  await page.click("#viewRoutes");
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await page.click("#viewEnroute");
  await expect(page.locator("#manifest .mqty-input").first()).toBeVisible({ timeout: 8000 });
  await page.fill("#manifestAddInput", loot);
  await page.click("#manifestAddBtn");

  const line = page.locator("#manifest .mline.acquired");
  await expect(line).toHaveCount(1);
  // 1 SCU par défaut : on ne remplit pas la soute d'un fret qu'on ne peut pas acheter ici.
  await expect(line.locator(".mqty-input")).toHaveValue("1");
  // Le côté achat est balisé, plus chiffré à 0 comme un vrai relevé UEX. (La ligne peut être
  // AUSSI « carry » si ce butin n'est pas vendable à l'arrivée : les deux tags coexistent.)
  const prix = (await line.locator(".mprice").innerText()).trim();
  expect(prix).toContain("acquis ailleurs");
  expect(prix.startsWith("0")).toBe(false);
  // Le stock d'un fret introuvable sur place n'est pas un chiffre corrigeable.
  await expect(line.locator(".mstock")).toContainText("stock —");
});

// ---------- Chargement du marché : l'échec réseau ne doit pas être collant (#38) ----------

// Le service worker est BLOQUÉ ici : on teste la logique de chargement d'app.js, pas le cache.
// (page.route n'intercepte de toute façon pas les requêtes émises par un service worker.)
test.describe("chargement du marché", () => {
  test.use({ serviceWorkers: "block" });


  test("marché indisponible : l'échec n'est pas mémorisé et l'action suivante réessaie", async ({ page }) => {
    let hits = 0;
    await page.route("**/data/market.json", (route) => {
      hits++;
      return hits === 1 ? route.abort("failed") : route.continue(); // 1re tentative KO, puis réseau OK
    });

    await page.click("#viewEnroute"); // 1er besoin du marché -> échoue
    await expect(page.locator("#toast")).toContainText("Marché indisponible");
    expect(hits).toBe(1);

    // Le repli vide n'est pas mémorisé : revenir sur la vue relance un chargement, qui aboutit.
    await page.click("#viewRoutes");
    await page.click("#viewEnroute");
    await expect(page.locator("#originList option").first()).toBeAttached({ timeout: 8000 });
    expect(hits).toBeGreaterThan(1);
  });

  test("marché : une salve de frappes pendant le chargement ne déclenche qu'un seul fetch", async ({ page }) => {
    let hits = 0;
    await page.route("**/data/market.json", async (route) => {
      hits++;
      await new Promise((r) => setTimeout(r, 800)); // chargement lent : laisse le temps de taper
      return route.continue();
    });

    await page.click("#viewCommodities");
    for (const c of ["l", "a", "r", "a"]) await page.type("#search", c, { delay: 20 });
    await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible({ timeout: 15000 });
    expect(hits).toBe(1); // la promesse en vol est mémorisée, pas re-déclenchée à chaque frappe
  });
});

// ---------- Service worker : le cache doit réellement se remplir (#66) ----------

test("service worker : les données atterrissent vraiment dans le cache", async ({ page }) => {
  // Régression : `putInCache` appelait `res.clone()` DANS le `.then()` de `caches.open()`, donc
  // après que la page ait consommé le corps -> « Response body is already used ». Le cache ne
  // contenait que les 8 fichiers précachés à l'installation : le repli hors-ligne, qui est toute
  // la raison d'être du mode « réseau d'abord, cache en repli », n'avait jamais rien à servir.
  await page.reload(); // 1re visite : le SW s'installe ; il ne contrôle la page qu'ensuite
  await expect(page.locator("#rows tr").first()).toBeVisible();

  const dataEnCache = async () => page.evaluate(async () => {
    const keys = await caches.keys();
    if (!keys.length) return [];
    const c = await caches.open(keys[0]);
    return (await c.keys()).map((r) => new URL(r.url).pathname).filter((p) => p.includes("/data/"));
  });
  await expect.poll(dataEnCache, { timeout: 15000 }).toContain("/data/routes.json");
});

// ---------- Corrections locales & réactivité des filtres (#39, #49) ----------

test("consulter un chiffre ne crée aucune correction locale", async ({ page }) => {
  await expect(page.locator("#viewCorrections")).toHaveText("✎ Corrections"); // aucune au départ
  const cell = page.locator("#rows .editv").first();
  const avant = await cell.innerText();

  await cell.click();
  await expect(cell.locator("input")).toBeVisible();
  await page.locator("h1").click(); // blur SANS rien modifier

  await expect(page.locator("#viewCorrections")).toHaveText("✎ Corrections"); // toujours aucune
  await expect(page.locator("#rows .editv.ov")).toHaveCount(0);
  await expect(cell).toHaveText(avant); // l'affichage d'origine est restauré, ✎ compris

  // Effet de bord réglé : le clic suivant n'est plus avalé par un re-render global.
  const autre = page.locator("#rows .editv").nth(3);
  await autre.click();
  await expect(autre.locator("input")).toBeVisible();
});

test("modifier un chiffre crée bien une correction (contre-épreuve)", async ({ page }) => {
  const cell = page.locator("#rows .editv").first();
  await cell.click();
  await cell.locator("input").fill("12345");
  await page.keyboard.press("Enter");
  await expect(page.locator("#viewCorrections")).toContainText("Corrections (1)");
  await expect(page.locator("#rows .editv.ov").first()).toBeVisible();
});

test("les filtres à saisie libre sont débouncés : un mot tapé ne re-rend qu'une fois", async ({ page }) => {
  await page.evaluate(() => {
    window.__rendus = 0;
    new MutationObserver(() => { window.__rendus++; }).observe(document.getElementById("rows"), { childList: true });
  });
  await page.type("#search", "Laranite", { delay: 20 }); // 8 frappes

  // saveState() tourne à la FIN de refresh() : le hash ne bouge qu'une fois le debounce tiré.
  await expect(page).toHaveURL(/search=Laranite/);
  // Sans debounce : 8 reconstructions complètes de la table (528 Ko de HTML chacune).
  expect(await page.evaluate(() => window.__rendus)).toBeLessThanOrEqual(2);
});

// ---------- Manifestes de jambe : intention persistée, pas instantané (#40, #42, #48) ----------

// Ouvre l'éditeur d'une jambe SANS y toucher (le helper ci-dessus, lui, ajuste les SCU et bascule
// donc la jambe en « éditée » — ce qu'on veut justement éviter ici).
async function openLegEditorPristine(page) {
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await expect(page.locator("#journeyCard .jcargo-item").first()).toBeVisible({ timeout: 8000 });
  await page.locator("#journeyCard .jleg-head").first().click();
  await expect(page.locator("#journeyCard .jman")).toBeVisible();
}

test("jambe : un ajout refusé pour doublon ne bascule pas la jambe en « éditée »", async ({ page }) => {
  await openLegEditorPristine(page);
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(0); // manifeste encore optimal
  const deja = (await page.locator("#journeyCard .jman-line .jman-name").first().innerText()).trim().split("\n")[0];

  await page.fill("#journeyCard .jman-add-input", deja);
  await page.click("#journeyCard .jman-add-btn");

  // Rien n'a été ajouté ET la jambe n'est pas devenue « personnalisée » : sans le correctif,
  // materializeLeg s'exécutait AVANT la garde et gelait le manifeste sur les prix du jour.
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2"))).toBeFalsy();
});

test("jambe : seule l'intention est persistée, jamais un instantané de marché", async ({ page }) => {
  await openLegEditorWithFreeSpace(page);
  await page.locator("#journeyCard .jman-qty").first().fill("3");
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1);

  const stock = JSON.parse(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2")));
  const lignes = Object.values(stock)[0];
  expect(lignes.length).toBeGreaterThan(0);
  // Ni buyPrice, ni sellPrice, ni margin, ni buyUpdated : ces champs se figeaient pour toujours
  // et la carte Voyage continuait d'annoncer un profit calculé sur des prix périmés.
  for (const l of lignes) expect(Object.keys(l).sort()).toEqual(["name", "units"]);
  // La clé porte le RANG de la jambe : deux jambes identiques ne partagent plus un manifeste.
  expect(Object.keys(stock)[0]).toMatch(/^\d+\|/);
});

test("effacer le voyage purge les manifestes édités", async ({ page }) => {
  await openLegEditorWithFreeSpace(page);
  await page.locator("#journeyCard .jman-qty").first().fill("3");
  await expect(page.locator("#journeyCard .jleg-edited")).toHaveCount(1);

  await page.locator("#journeyClear").click();
  // Sans la purge, ces éditions ressortaient sur un parcours ULTÉRIEUR passant par les mêmes
  // terminaux, badge ✎ compris, alors que l'utilisateur n'avait rien édité dans ce voyage-là.
  expect(await page.evaluate(() => localStorage.getItem("best-hauling-journey-edits-v2"))).toBe("{}");
});

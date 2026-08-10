import { test, expect } from "@playwright/test";

// Frais d'autoload : la fonctionnalité ne facture QUE si market.json porte `autoload`/`maxBox`, et
// l'instantané versionné dans data/ ne les porte pas encore (le pipeline les publie, mais la CI ne
// recommite jamais les data/*.json). Sans interception, ces tests seraient donc vacuisants : ils
// vérifieraient le chemin dégradé en croyant vérifier le chemin actif. On enrichit le marché à la
// volée pour tester ce que l'utilisateur verra une fois `npm run build` passé en production.
//
// `serviceWorkers: "block"` est INDISPENSABLE : le service worker sert data/market.json depuis son
// cache (réseau d'abord, cache en repli), et page.route ne voit alors jamais la requête.
test.use({ serviceWorkers: "block" });

// Enrichit market.json en vol. `mode` décide de ce que les terminaux déclarent :
//   "all"  : tout le monde propose l'autoload (chemin actif complet) ;
//   "none" : personne ne le propose (le champ EXISTE et vaut false -> « pas d'autoload ») ;
//   "raw"  : on ne touche à rien (champs absents -> « donnée UEX absente »), le cas d'aujourd'hui.
// `fixedMaxBox` impose le même plafond à tous les terminaux, pour les tests qui comparent un
// montant à un chiffre de la spec : celle-ci ancre ses relevés sur des caisses de 32 SCU, et un
// plafond plus bas change le nombre de caisses donc le montant (32 SCU font 1 caisse à 32, mais 2 à
// 24 comme à 16). Sans plafond imposé, on répartit des plafonds VARIÉS : un marché uniformément à
// 32 ne distinguerait pas un `maxBox` respecté d'un `maxBox` ignoré.
async function enrichMarket(page, mode, fixedMaxBox) {
  await page.route("**/data/market.json", async (route) => {
    const res = await route.fetch();
    const market = await res.json();
    if (mode !== "raw") {
      market.terminals.forEach((t, i) => {
        t.autoload = mode === "all";
        t.maxBox = fixedMaxBox || [32, 24, 16][i % 3];
      });
    }
    await route.fulfill({ response: res, json: market });
  });
}

// Les montants de la colonne profit, dans l'ordre du tableau. On garde le TEXTE : c'est lui qui
// porte le « ≈ », et une comparaison de texte attrape aussi un NaN ou un « undefined ».
const profits = (page) => page.locator("#rows tr td.profit:nth-last-child(2)").allTextContents();
const commodities = (page) => page.locator("#rows tr td:first-child .cname").allTextContents();

// Lit l'infobulle de frais : montant annoncé, manutention décrite et coefficient affiché. Une
// infobulle doit permettre de REFAIRE le calcul — c'est tout ce qui distingue une explication d'une
// décoration. Les nombres sont formatés en fr-FR (espace insécable étroite comme séparateur de
// milliers) : on ne garde que les chiffres.
const nombre = (s) => Number(String(s).replace(/\D/g, ""));
function feeDetail(title) {
  const m = title.match(/≈ ([\d\s\u00a0\u202f]+) aUEC déduits — ([\d\s\u00a0\u202f]+) SCU en (\d+) caisses?([^·]*).*?×([\d,]+) \(k global\)/);
  if (!m) return null;
  return {
    montant: nombre(m[1]), scu: nombre(m[2]), caisses: Number(m[3]),
    commodites: nombre(m[4]) || 1, // « sur N commodités » en multi ; une seule transaction sinon
    k: Number(m[5].replace(",", ".")),
  };
}
// La formule de la spec, appliquée aux nombres que l'infobulle affiche elle-même. Les deux
// extrémités partagent ici le k global, et les caisses sont faites au chargement (hypothèse 1) :
// le total est donc exactement deux fois l'opération.
const feeAttendu = (d) => 2 * Math.round(d.k * (150 * d.commodites + 30 * d.caisses + 20 * d.scu));

// Toute erreur JS non rattrapée fait échouer le test qui l'a provoquée. Un `title` mal composé ou
// un terminal absent du pont nom->terminal se manifeste par un pageerror, pas par un chiffre faux.
function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("défaut : l'interrupteur est inactif, le champ k masqué, aucun montant estimé", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();

  await expect(page.locator("#autoload")).not.toBeChecked();
  await expect(page.locator("#alkField")).toBeHidden();
  // Aucune cellule de profit ne doit porter le marqueur d'estimation tant que rien n'est facturé.
  for (const p of await profits(page)) expect(p).not.toContain("≈");
});

test("actif : les profits passent en net, le classement suit le net, le lien le transporte", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "all");
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();

  const brut = await profits(page);
  const ordreBrut = await commodities(page);

  await page.check("#autoload");
  await expect(page.locator("#alkField")).toBeVisible();
  // ensureFeeMarket charge market.json en tâche de fond puis re-rend : on attend le re-rendu.
  await expect(page.locator("#rows tr td.profit").first()).toContainText("≈");

  const net = await profits(page);
  const ordreNet = await commodities(page);

  // Non vacuisant : les montants ont RÉELLEMENT bougé, et vers le bas.
  expect(net).not.toEqual(brut);
  const nb = (s) => Number(s.replace(/[^0-9-]/g, ""));
  expect(nb(net[0])).toBeLessThan(nb(brut[0]));
  // L'exigence centrale de la spec : le tri suit le net, donc l'ordre du tableau change.
  expect(ordreNet).not.toEqual(ordreBrut);

  // L'infobulle EXPLIQUE le montant retenu (décomposition + tarif de chaque station).
  const title = await page.locator("#rows tr td.profit").first().getAttribute("title");
  expect(title).toContain("Frais d'autoload");
  expect(title).toContain("caisse");

  // Permalien : l'interrupteur et le k global sont partageables (les relevés par station, non).
  await expect.poll(() => page.evaluate(() => location.hash)).toContain("autoload=1");
  expect(errors).toEqual([]);
});

test("marge et ROI passent en net dans les DEUX modes, sans jamais changer de définition", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "all");
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();

  const marge = () => page.locator("#rows tr").first().locator("td.num").first();
  const roi = () => page.locator("#rows tr").first().locator("td.roi-badge").first();
  const nb = (s) => Number(String(s).replace(/[^0-9,-]/g, "").replace(",", "."));

  for (const multi of [false, true]) {
    // Repart du brut à chaque mode : c'est la comparaison brut/net DANS LE MÊME mode qui prouve
    // que la colonne a bien basculé, pas une différence entre les deux modes.
    await page.uncheck("#autoload");
    if (multi) await page.check("#multiCommodity"); else await page.uncheck("#multiCommodity");
    await expect(page.locator("#rows tr").first()).toBeVisible();
    const mBrut = nb(await marge().textContent());
    const rBrut = nb(await roi().textContent());
    expect(await marge().textContent()).not.toContain("≈");
    expect(await roi().textContent()).not.toContain("≈");

    await page.check("#autoload");
    await expect(page.locator("#rows tr td.profit").first()).toContainText("≈");
    // Le « ≈ » est la promesse de la spec : tout montant estimé le porte.
    await expect(marge()).toContainText("≈");
    await expect(roi()).toContainText("≈");
    // Non vacuisant : les valeurs ont réellement baissé, elles ne sont pas juste re-préfixées.
    expect(nb(await marge().textContent())).toBeLessThan(mBrut);
    expect(nb(await roi().textContent())).toBeLessThan(rBrut);
  }
  expect(errors).toEqual([]);
});

test("le coefficient global change les montants facturés", async ({ page }) => {
  await enrichMarket(page, "all");
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.check("#autoload");
  await expect(page.locator("#rows tr td.profit").first()).toContainText("≈");

  // Assertion sur le MONTANT, pas sur la chaîne : le title contient aussi l'étiquette « ×k », qui
  // change à elle seule. Une régression laissant k affiché mais ignoré dans le calcul passerait
  // alors au vert. On exige donc que le montant se refasse à partir du k affiché — et le tri
  // suivant le net, la première ligne peut très bien être une autre route après le changement.
  const detail = async () => feeDetail(await page.locator("#rows tr td.profit").first().getAttribute("title"));
  const avant = await detail();
  expect(avant).not.toBeNull();
  expect(avant.k).toBe(1.2);
  expect(avant.montant).toBe(feeAttendu(avant));

  await page.fill("#alk", "3");
  await expect.poll(async () => (await detail())?.k).toBe(3);
  const apres = await detail();
  expect(apres.montant).toBe(feeAttendu(apres));
  // Non vacuisant : à manutention comparable, un k 2,5 fois plus grand facture 2,5 fois plus.
  expect(apres.montant / feeAttendu({ ...apres, k: 1.2 })).toBeGreaterThan(2.4);
});

test("chargement multi-commodité : l'infobulle compte les caisses PAR commodité", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "all", 32);
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.check("#autoload");
  await page.check("#multiCommodity");
  await expect(page.locator("#rows tr td.profit").first()).toContainText("≈");

  // Une caisse ne contient qu'UNE commodité : décomposer le TOTAL des SCU annonçait un nombre de
  // caisses — et une formule — qui ne redonnaient pas le montant déduit (66 % d'écart mesuré).
  const d = feeDetail(await page.locator("#rows tr td.profit").first().getAttribute("title"));
  expect(d, "l'infobulle multi doit décrire sa manutention").not.toBeNull();
  expect(d.commodites).toBeGreaterThan(1);
  expect(d.montant).toBe(feeAttendu(d));

  // Et le décompte annoncé est celui du détail déplié, qui décompose ligne par ligne.
  await page.locator("#rows tr .route-toggle").first().click();
  const boxes = await page.locator("#rows .schema-row .mboxes").allTextContents();
  expect(boxes.length).toBe(d.commodites);
  const parLigne = boxes.reduce((a, t) => a + [...t.matchAll(/(\d+)×\d+/g)].reduce((s, x) => s + Number(x[1]), 0), 0);
  expect(d.caisses).toBe(parLigne);
  // La colonne SCU annonce la MÊME décomposition que le détail (l'incohérence était visible à l'œil).
  const scuTitle = await page.locator("#rows tr:first-child td.num").nth(2).getAttribute("title");
  expect([...scuTitle.matchAll(/(\d+)×\d+/g)].reduce((s, x) => s + Number(x[1]), 0)).toBe(parLigne);
  expect(errors).toEqual([]);
});

test("station sans autoload : le zéro est EXPLIQUÉ, jamais muet", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "none");
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.check("#autoload");

  // ⊘ = « rien facturé, et voici pourquoi » — à ne pas confondre avec un frais oublié.
  await expect(page.locator("#rows tr .nofee").first()).toBeVisible();
  const title = await page.locator("#rows tr td.profit").first().getAttribute("title");
  expect(title).toContain("pas d'autoload");
  expect(errors).toEqual([]);
});

test("dégradation : sans les champs UEX, les profits sont IDENTIQUES et rien ne casse", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "raw"); // l'instantané réel : ni `autoload` ni `maxBox`
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();

  const brut = await profits(page);
  await page.check("#autoload");
  await expect(page.locator("#rows tr .nofee").first()).toBeVisible(); // marché chargé et re-rendu

  // Aucun frais calculable -> les montants ne bougent pas d'un caractère, et aucun « ≈ » ne ment.
  const apres = (await profits(page)).map((s) => s.replace(/\s*⊘\s*$/, "").trim());
  expect(apres).toEqual(brut.map((s) => s.trim()));
  const title = await page.locator("#rows tr td.profit").first().getAttribute("title");
  expect(title).toContain("donnée UEX absente");
  expect(errors).toEqual([]);
});

test("manifeste : une ligne « vend ailleurs » ne paie que son chargement, et le total le montre", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "all", 32);
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.check("#autoload");

  // ▶ sur un trajet : « En route » se pré-remplit avec ses deux terminaux, donc le manifeste existe.
  await page.locator("#rows tr").first().locator(".journey-pick").click();
  await page.click("#viewEnroute");
  await expect(page.locator("#manifest .mqty-input").first()).toBeVisible({ timeout: 8000 });

  // Une commodité ACHETABLE au départ mais invendable à l'arrivée : c'est la définition d'une ligne
  // « vend ailleurs ». On la choisit dans les données plutôt qu'au hasard, pour que le test porte
  // toujours sur le cas visé (et échoue bruyamment si l'instantané ne l'offre plus).
  const carry = await page.evaluate(async ([o, d]) => {
    const m = await (await fetch("data/market.json")).json();
    const oi = m.terminals.findIndex((t) => t.name === o), di = m.terminals.findIndex((t) => t.name === d);
    const c = m.commodities.find((x) => x.buys.some((b) => b[0] === oi) && !x.sells.some((s) => s[0] === di));
    return c ? c.name : null;
  }, [(await page.inputValue("#origin")).split(" — ")[0], (await page.inputValue("#destTerminal")).split(" — ")[0]]);
  expect(carry, "aucune commodité « vend ailleurs » disponible pour ce trajet").toBeTruthy();

  await page.fill("#manifestAddInput", carry);
  await page.click("#manifestAddBtn");
  await expect(page.locator("#manifest .mline.carry")).toHaveCount(1);

  // L'invariant : la somme des profits AFFICHÉS fait le total AFFICHÉ. La ligne « vend ailleurs »
  // payait DEUX opérations — dont un déchargement qui n'a jamais lieu — tout en affichant « — » :
  // le total baissait sans qu'aucune ligne à l'écran ne l'explique.
  const val = (t) => (t.trim() === "—" ? 0 : Number(t.replace(/[^\d-]/g, "")));
  const lignes = (await page.locator("#manifest .mline .mprofit").allTextContents()).map(val);
  const total = val(await page.locator("#manifestTot .profit").first().innerText());
  expect(lignes.reduce((a, b) => a + b, 0)).toBe(total);
  // Non vacuisant : cette ligne porte bien un chargement facturé, et rien d'autre.
  expect(lignes.filter((v) => v < 0)).toHaveLength(1);
  expect(errors).toEqual([]);
});

// Ces trois vues ne reçoivent PAS le contexte de frais comme les autres : elles passent par
// `feeResolver`, qui est le résolveur qu'app.js fabrique pour multiTrips / bestManifest /
// buildChainAdjacency. C'est la couture la plus fragile entre le moteur et l'interface — un
// résolveur qui rendrait `null` laisserait tout au brut SANS rien casser à l'écran. On exige donc
// ici que les frais soient VISIBLEMENT facturés, pas seulement que rien ne plante : sans ces
// assertions, une régression du câblage passerait au vert (vérifié par mutation).
test("les vues qui passent par le résolveur facturent réellement (multi, chaîne, manifeste)", async ({ page }) => {
  const errors = watchErrors(page);
  await enrichMarket(page, "all");
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.check("#autoload");

  // Boucles : quatre opérations (deux jambes), les caisses faites au départ de chacune.
  await page.click("#viewLoops");
  await expect(page.locator("#loopRows tr").first()).toBeVisible();
  await expect(page.locator("#loopRows tr td.profit").first()).toContainText("≈");
  expect(await page.locator("#loops").textContent()).not.toMatch(/NaN|undefined/);

  // Chaîne : les frais arrivent par le leg, saut par saut (buildChainAdjacency les y estampille).
  // La sortie reste masquée tant qu'aucune origine n'est choisie.
  await page.click("#viewChain");
  await expect(page.locator("#chainControls")).toBeVisible();
  const origin = await page.locator("#originList option").first().getAttribute("value");
  await page.fill("#chainOrigin", origin);
  await expect(page.locator("#chainOut .chain-leg").first()).toBeVisible();
  await expect(page.locator("#chainOut .chain-tot")).toContainText("frais ≈");
  expect(await page.locator("#chainOut").textContent()).not.toMatch(/NaN|undefined/);

  // En route : le manifeste optimal (bestManifest) chiffre son total en net.
  await page.click("#viewEnroute");
  await page.fill("#origin", origin);
  await expect(page.locator("#manifest")).toBeVisible();
  await expect(page.locator("#manifest")).toContainText("frais");
  expect(await page.locator("#manifest").textContent()).not.toMatch(/NaN|undefined/);

  // Trajets multi-commodité (multiTrips) : le tri ET la troncature portent sur le net.
  await page.click("#viewRoutes");
  await page.check("#multiCommodity");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await expect(page.locator("#rows tr td.profit").first()).toContainText("≈");
  expect(await page.locator("#routes").textContent()).not.toMatch(/NaN|undefined/);

  expect(errors).toEqual([]);
});

test("relevé de station : k déduit d'un montant observé, persistant, hors du lien", async ({ page }) => {
  await enrichMarket(page, "all", 32); // caisses de 32 SCU : l'ancrage des relevés de la spec
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();
  await page.check("#autoload");

  await page.click("#viewCorrections");
  await expect(page.locator("#correctionsControls")).toBeVisible();

  // On sélectionne une station par son libellé exact (la datalist n'est peuplée qu'après market.json).
  const label = await page.locator("#stationList option").first().getAttribute("value");
  await page.fill("#station", label);
  await page.locator("#station").dispatchEvent("input");
  await expect(page.locator("#alAmount")).toBeVisible();

  // 1 159 aUEC observés pour 32 SCU -> autoloadFee(32, 32, 1) = 820 -> k ≈ 1,413 (le relevé de Ruin).
  await page.fill("#alAmount", "1159");
  await page.fill("#alScu", "32");
  await page.click("#alSave");
  await expect(page.locator(".corr-item.autoload")).toContainText("1,41");

  // Un relevé n'est PAS une correction de prix. Le compteur du bouton « ✎ Corrections » compte les
  // clés du store des corrections : si les relevés y atterrissaient, il afficherait « (1) » ici.
  // C'est exactement ce que garantit le choix d'un store localStorage séparé.
  await expect(page.locator("#viewCorrections")).toHaveText("✎ Corrections");
  // Ni dans le lien (il est local, comme les corrections).
  expect(await page.evaluate(() => location.hash)).not.toContain("1159");

  // Le rechargement restaure la vue courante : on revient donc directement sur « Corrections ».
  await page.reload();
  await expect(page.locator("#correctionsControls")).toBeVisible();
  await expect(page.locator("#stationList option").first()).toBeAttached(); // marché rechargé
  await page.fill("#station", label);
  await page.locator("#station").dispatchEvent("input");
  await expect(page.locator(".corr-item.autoload")).toContainText("1,41"); // survit au rechargement
});

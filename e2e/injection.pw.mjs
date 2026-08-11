import { test, expect } from "@playwright/test";

// UEX est une source tierce et le pipeline recopie ses champs dans data/*.json. Ces tests injectent
// dans le flux ce qu'un relevé hostile — ou simplement corrompu — y mettrait, et vérifient que rien
// n'en ressort comme du HTML. `serviceWorkers: "block"` est indispensable : sans lui le SW sert les
// données depuis son cache et page.route ne voit jamais la requête.
test.use({ serviceWorkers: "block" });

// Charge utile refermant l'attribut en cours pour en ouvrir d'autres. `tabindex="0"` étant déjà posé
// par editv, un `onfocus` s'exécuterait sans clic ; `onmouseover` suffirait d'un survol.
const CHARGE = '0" autofocus onfocus="window.__xss=1" data-x="';

// Vérifie qu'un span d'édition n'a pas gagné d'attribut, et que la valeur hostile a été REJETÉE
// plutôt que recopiée : un stock non numérique n'a aucun sens, le champ number le refuserait.
async function inerte(span) {
  const attrs = await span.evaluate((el) => el.getAttributeNames());
  for (const interdit of ["onfocus", "autofocus", "onmouseover", "data-x"]) {
    expect(attrs, `attribut injecté « ${interdit} »`).not.toContain(interdit);
  }
  expect(await span.getAttribute("data-v")).toBe("");
  expect(await span.getAttribute("data-u")).toBe("0");
}

test("un stock UEX hostile ne devient jamais un attribut HTML (routes.json)", async ({ page }) => {
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(String(e)));
  let empoisonnee = null;
  await page.route("**/data/routes.json", async (route) => {
    const res = await route.fetch();
    const routes = await res.json();
    empoisonnee = routes[0].commodity;
    routes[0].buy.stock = CHARGE;
    routes[0].buy.updated = CHARGE;
    await route.fulfill({ response: res, json: routes });
  });
  await page.goto("/index.html");
  await expect(page.locator("#rows tr").first()).toBeVisible();

  // Non vacuisant : c'est bien la ligne empoisonnée qu'on inspecte. Sans cette ancre, le test
  // passerait aussi sur une page où l'injection n'aurait jamais atteint le rendu.
  const ligne = page.locator("#rows tr").first();
  expect(await ligne.locator(".cname").innerText()).toBe(empoisonnee);
  await inerte(ligne.locator(".editv[data-f='vol']").first());

  // Et rien ne s'est exécuté : ni le handler injecté, ni une erreur de parsing.
  await page.mouse.move(10, 10);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(erreurs).toEqual([]);
});

test("la même charge venue de market.json (vue En route) reste inerte", async ({ page }) => {
  // Second flux de données, second chemin de rendu, même fonction editv : routes.json alimente le
  // tableau « Trajets », market.json alimente « En route ». Une seule correction couvre les deux,
  // mais rien ne le garantit tant qu'un test ne parcourt pas aussi le second.
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(String(e)));
  await page.route("**/data/market.json", async (route) => {
    const res = await route.fetch();
    const market = await res.json();
    for (const c of market.commodities) {
      for (const b of c.buys) { b[2] = CHARGE; b[3] = CHARGE; }   // stock, date de relevé
      for (const s of c.sells) { s[2] = CHARGE; s[3] = CHARGE; } // demande, date de relevé
    }
    await route.fulfill({ response: res, json: market });
  });
  await page.goto("/index.html");
  await page.click("#viewEnroute");
  await expect(page.locator("#destTerminal")).toBeVisible();
  await expect(page.locator("#originList option").first()).toBeAttached({ timeout: 8000 });
  await page.fill("#origin", await page.locator("#originList option").first().getAttribute("value"));

  const spans = page.locator("#enrouteRows .editv[data-f='vol']");
  await expect(spans.first()).toBeAttached({ timeout: 8000 });
  await inerte(spans.first());
  await page.mouse.move(10, 10);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(erreurs).toEqual([]);
});

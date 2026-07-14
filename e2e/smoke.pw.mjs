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

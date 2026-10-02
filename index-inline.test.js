const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("todos os scripts inline do HTML continuam sintaticamente válidos", () => {
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]) && match[2].trim())
    .map((match) => match[2]);
  assert.ok(inlineScripts.length > 0);
  inlineScripts.forEach((source) => new vm.Script(source));
});

test("HTML não contém hashes de senha nem carrega agenda como arquivo público", () => {
  assert.doesNotMatch(html, /passwordHash|activities-data\.js|RECARGA_CLUB_ACTIVITIES/);
});

test("interface não inclui compactação de vídeos nem dependência do Supabase", () => {
  assert.doesNotMatch(html, /Supabase|supabase|FFmpeg|compress-video|videoCompressor|compactador de vídeo/i);
  assert.match(html, /recarga_app_server_url/);
  assert.match(html, /getAppServerUrl\("\/api\/auth\/login"\)/);
});

test("editor de estoque ancora check e quantidade na linha OCR selecionada", () => {
  const start = html.indexOf("function drawInventoryEditedImage() {");
  const end = html.indexOf("async function processInventoryImage(file)", start);
  assert.ok(start >= 0 && end > start);
  const renderer = html.slice(start, end);
  assert.match(renderer, /ctx\.font = `400 \$\{fontSize\}px Arial, Helvetica, sans-serif`/);
  assert.match(renderer, /rowTextHeight \* 1\.25/);
  assert.ok(renderer.indexOf("ctx.font =") < renderer.indexOf("ctx.measureText(quantity)"));
  assert.match(renderer, /centerY = box\.cy/);
  assert.match(renderer, /checkboxCenterY = box\.cy/);
  assert.match(renderer, /bitmap\.width \* 0\.11/);
  assert.match(renderer, /bitmap\.width \* 0\.035/);
  assert.match(html, /labelStartX - Math\.max\(checkboxSizeHint \* 4, rowTextHeight \* 4\.1\)/);
  assert.match(html, /!\/\^\[xv\]\$\/i\.test\(word\.text\.trim\(\)\)/);
  assert.doesNotMatch(renderer, /findInventoryCheckboxBox|detectedCheckbox/);
});

test("campos de desconto preservam as casas decimais usadas nos limites da tabela", () => {
  const start = html.indexOf("      function parsePercentageInput(value)");
  const end = html.indexOf("      function parseIntegerInput(value)", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {};
  vm.runInNewContext(`${html.slice(start, end)}\nglobalThis.format = formatPercentageInput;`, sandbox);
  assert.equal(sandbox.format("6,54"), "6,54%");
  assert.equal(sandbox.format("5.005%"), "5,005%");
});

test("OCR mantém cada quantidade associada à linha e ao rótulo corretos", () => {
  const normalizeStart = html.indexOf("      function normalize(value)");
  const normalizeEnd = html.indexOf("\n      const SUPPLY_CATALOG", normalizeStart);
  const inventoryStart = html.indexOf("      function getWordBBox(word)");
  const inventoryEnd = html.indexOf("      function populateInventoryItems(rows)", inventoryStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart && inventoryStart >= 0 && inventoryEnd > inventoryStart);
  const sandbox = {};
  vm.runInNewContext([
    html.slice(normalizeStart, normalizeEnd),
    html.slice(inventoryStart, inventoryEnd),
    "globalThis.extract = extractInventoryRowsFromOcr;"
  ].join("\n"), sandbox);
  const word = (text, x, y, width, height = 16) => ({
    text,
    bbox: { x0: x, y0: y, x1: x + width, y1: y + height }
  });
  const words = [
    word("Disponível", 570, 20, 80),
    word("x", 47, 62, 10, 12), word("9MM", 124, 60, 33), word("/", 160, 60, 8), word("38", 171, 60, 19), word("TPC", 195, 60, 29), word("7", 604, 60, 12),
    word("x", 47, 112, 10, 12), word("38", 124, 110, 19), word("SPL", 147, 110, 25), word("/", 178, 110, 8), word("357", 190, 110, 29), word("MAG", 224, 110, 33), word("35", 602, 110, 18),
    word("x", 47, 162, 10, 12), word("380", 124, 160, 29), word("ACP", 158, 160, 28), word("92", 602, 160, 18)
  ];
  const rows = sandbox.extract({ data: { words } }, 1, { width: 846, height: 220 });
  assert.equal(JSON.stringify(rows.map((row) => [row.label, row.quantity])), JSON.stringify([
    ["9MM / 38 TPC", "7"],
    ["38 SPL / 357 MAG", "35"],
    ["380 ACP", "92"]
  ]));
  assert.ok(rows.every((row, index) => Math.abs(row.quantityBox.cy - [68, 118, 168][index]) < 1));
  assert.ok(rows.every((row) => row.checkboxCenterX > 45 && row.checkboxCenterX < 65));
});

test("comissão segue todas as faixas de PIX e cartão e preserva a base de 0,40%", () => {
  const rulesStart = html.indexOf("      const COMMISSION_RULES = Object.freeze({");
  const rulesEnd = html.indexOf("\n\n      const RECARGA_LOGO_DATA_URI", rulesStart);
  const prizeStart = html.indexOf("      function getPrizeRule(");
  const prizeEnd = html.indexOf("      function populateCommissionInstallments(", prizeStart);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart && prizeStart >= 0 && prizeEnd > prizeStart);
  const sandbox = {};
  const source = [
    html.slice(rulesStart, rulesEnd),
    "function parseIntegerInput(value) { const parsed = Number.parseInt(String(value || '').replace(/[^\\d-]/g, ''), 10); return Number.isFinite(parsed) ? Math.max(0, parsed) : 0; }",
    html.slice(prizeStart, prizeEnd),
    "globalThis.api = { getPrizeRule, calculateCommissionValues };"
  ].join("\n");
  vm.runInNewContext(source, sandbox);
  const { getPrizeRule, calculateCommissionValues } = sandbox.api;
  const rate = (payment, discount, installments = 1) => getPrizeRule(payment, discount, installments).prizeRate;

  assert.equal(rate("pix", 10), 0.015);
  assert.equal(rate("pix", 10.01), 0.012);
  assert.equal(rate("pix", 12), 0.012);
  assert.equal(rate("pix", 15), 0.01);
  assert.equal(rate("pix", 20), 0.008);
  assert.equal(rate("pix", 20.01), 0);
  assert.equal(rate("card", 5, 3), 0.014);
  assert.equal(rate("card", 5.01, 3), 0.012);
  assert.equal(rate("card", 6.5, 3), 0.012);
  assert.equal(rate("card", 6.54, 3), 0.009);
  assert.equal(rate("card", 8, 3), 0.009);
  assert.equal(rate("card", 8.01, 3), 0);
  assert.equal(rate("card", 5, 6), 0.012);
  assert.equal(rate("card", 6.5, 9), 0.008);
  assert.equal(rate("card", 8, 12), 0.005);
  assert.equal(rate("card", 8, 13), 0.002);
  assert.equal(rate("card", 8.01, 15), 0);
  assert.equal(rate("card", 6.5, 18), 0.003);
  assert.equal(rate("card", 6.51, 18), 0);
  assert.equal(rate("card", 5, 21), 0.003);
  assert.equal(rate("card", 6.5, 21), 0.002);
  assert.equal(rate("card", 6.51, 21), 0);

  const sale = calculateCommissionValues({
    valorOriginal: 10000,
    descontoPercentual: 10,
    frete: 200,
    formaPagamento: "pix"
  });
  assert.equal(sale.valorLiquidoPedido, 9200);
  assert.ok(Math.abs(sale.comissaoBase - 36.8) < 1e-10);
  assert.ok(Math.abs(sale.premioNegociacao - 138) < 1e-10);
  assert.ok(Math.abs(sale.totalVariavelVenda - 174.8) < 1e-10);
});

test("pagamento dividido calcula o prêmio sobre o valor pago em cada modalidade", () => {
  const rulesStart = html.indexOf("      const COMMISSION_RULES = Object.freeze({");
  const rulesEnd = html.indexOf("\n\n      const RECARGA_LOGO_DATA_URI", rulesStart);
  const prizeStart = html.indexOf("      function getPrizeRule(");
  const prizeEnd = html.indexOf("      function populateCommissionInstallments(", prizeStart);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart && prizeStart >= 0 && prizeEnd > prizeStart);
  const sandbox = {};
  vm.runInNewContext([
    html.slice(rulesStart, rulesEnd),
    "function parseIntegerInput(value) { const parsed = Number.parseInt(String(value || '').replace(/[^\\d-]/g, ''), 10); return Number.isFinite(parsed) ? Math.max(0, parsed) : 0; }",
    html.slice(prizeStart, prizeEnd),
    "globalThis.calculate = calculateCommissionValues;"
  ].join("\n"), sandbox);

  const sale = sandbox.calculate({
    valorOriginal: 2000,
    descontoPercentual: 0,
    frete: 0,
    formaPagamento: "split",
    paymentSplit: { pixAmount: 1000, cardAmount: 1000, cardInstallments: 6 }
  });
  assert.equal(sale.valorTotalModalidades, 2000);
  assert.equal(sale.premioPix, 15);
  assert.equal(sale.premioCartao, 12);
  assert.equal(sale.premioNegociacao, 27);
  assert.equal(sale.comissaoBase, 8);
  assert.equal(sale.totalVariavelVenda, 35);
  assert.equal(sale.percentualPremio, 0.0135);

  const discounted = sandbox.calculate({
    valorOriginal: 2000,
    descontoPercentual: 5,
    frete: 0,
    formaPagamento: "split",
    paymentSplit: { pixAmount: 1000, cardAmount: 900, cardInstallments: 6 }
  });
  assert.equal(discounted.valorLiquidoPedido, 1900);
  assert.equal(discounted.valorTotalModalidades, 1900);
  assert.equal(discounted.premioPix, 15);
  assert.equal(discounted.premioCartao, 10.8);
  assert.equal(discounted.premioNegociacao, 25.8);
});

test("comissão do orçamento fica recolhida até o clique e o botão de copiar vem antes", () => {
  const copyButton = html.indexOf('id="copyQuoteMessage"');
  const commissionToggle = html.indexOf('id="quoteCommissionToggle"');
  const commissionPanel = html.indexOf('id="quoteCommissionPanel"');
  assert.ok(copyButton >= 0 && commissionToggle > copyButton && commissionPanel > commissionToggle);
  assert.match(html.slice(commissionToggle, commissionPanel), /hidden[\s\S]*aria-expanded="false"/);
  const quotePanel = html.slice(commissionPanel, html.indexOf('id="quoteInstallmentsPreview"', commissionPanel));
  assert.match(quotePanel, /id="quoteCommissionValue"/);
  assert.match(quotePanel, /id="quoteCommissionRate"/);
  assert.match(quotePanel, /Mostrar detalhes/);
  assert.doesNotMatch(quotePanel, /Faixa aplicada|commissionRulesTable|quoteCommissionRule/);
  assert.match(html.slice(html.indexOf('id="commissionCalculatorPanel"'), html.indexOf('id="commissionRulesTable"')), /Faixa utilizada/);
  assert.ok(html.indexOf('id="commissionRulesTable"') > html.indexOf('id="commissionCalculatorPanel"'));
  assert.match(html, /aria-labelledby="commissionRulesHeading"/);
  assert.match(html, /state\.quoteCommissionOpen = !state\.quoteCommissionOpen/);
  assert.match(html, /state\.quoteCommissionOpen = false;[\s\S]*el\.quoteCommissionPayment\.value = "pix"/);
});

test("tabela de comissão destaca somente a faixa de pagamento, parcelas e desconto selecionados", () => {
  const rulesStart = html.indexOf("      const COMMISSION_RULES = Object.freeze({");
  const rulesEnd = html.indexOf("\n\n      const RECARGA_LOGO_DATA_URI", rulesStart);
  const tableStart = html.indexOf("      function renderCommissionRulesTable(");
  const tableEnd = html.indexOf("      function updateQuoteCommissionCalculator(", tableStart);
  const prizeStart = html.indexOf("      function getPrizeRule(");
  const prizeEnd = html.indexOf("      function calculateCommissionValues(", prizeStart);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart && tableStart >= 0 && tableEnd > tableStart && prizeStart >= 0 && prizeEnd > prizeStart);
  const sandbox = {
    el: { commissionRulesTable: { innerHTML: "" }, commissionRulesCurrent: { textContent: "" } },
    escapeHtml: (value) => String(value),
    formatDetailedPercent: (value) => `${Number(value).toFixed(2)}%`,
    parseIntegerInput: (value) => Number.parseInt(value, 10) || 0
  };
  vm.runInNewContext([
    html.slice(rulesStart, rulesEnd),
    html.slice(prizeStart, prizeEnd),
    html.slice(tableStart, tableEnd),
    "globalThis.render = renderCommissionRulesTable; globalThis.output = el.commissionRulesTable;"
  ].join("\n"), sandbox);

  sandbox.render("card", 5, 6);
  const cardRows = [...sandbox.output.innerHTML.matchAll(/<tr class="commission-rule-current" aria-current="true">([\s\S]*?)<\/tr>/g)];
  assert.equal(cardRows.length, 1);
  assert.match(cardRows[0][1], /Cartão 4x a 6x/);
  assert.match(cardRows[0][1], /Até 5%/);
  assert.match(cardRows[0][1], /1\.20%/);
  assert.match(cardRows[0][1], /Orçamento atual/);

  sandbox.render("pix", 10, 1);
  const pixRows = [...sandbox.output.innerHTML.matchAll(/<tr class="commission-rule-current" aria-current="true">([\s\S]*?)<\/tr>/g)];
  assert.equal(pixRows.length, 1);
  assert.match(pixRows[0][1], /PIX/);
  assert.match(pixRows[0][1], /Até 10%/);
  assert.match(pixRows[0][1], /1\.50%/);

  sandbox.render("card", 5, 6, false);
  assert.doesNotMatch(sandbox.output.innerHTML, /aria-current="true"/);
  assert.match(sandbox.el.commissionRulesCurrent.textContent, /Preencha o valor da venda/);

  sandbox.render("split", 5, 6, true, { pixAmount: 1000, cardAmount: 1000, cardInstallments: 6 });
  const splitRows = [...sandbox.output.innerHTML.matchAll(/<tr class="commission-rule-current" aria-current="true">([\s\S]*?)<\/tr>/g)];
  assert.equal(splitRows.length, 2);
  assert.match(splitRows[0][1], /PIX/);
  assert.match(splitRows[1][1], /Cartão 4x a 6x/);
  assert.match(sandbox.output.innerHTML, /cada modalidade/);
});

test("tutorial de atualização se limita à comissão e preenche os detalhes a partir do orçamento", () => {
  const start = html.indexOf("      const UPDATE_TOUR_STEPS = [");
  const end = html.indexOf("      const UPDATE_TOUR_DEMO_MESSAGE", start);
  assert.ok(start >= 0 && end > start);
  const tourSteps = html.slice(start, end);
  assert.equal((tourSteps.match(/target:/g) || []).length, 2);
  assert.match(html, /2026-10-02-tour-v9/);
  assert.match(tourSteps, /target: "#quoteCommissionDetailsButton"[\s\S]*requiresUserArea: true/);
  assert.match(html, /id="quoteCommissionToggle"[^>]*>Quanto vou ganhar\?/);
  assert.match(tourSteps, /Mostrar detalhes/);
  assert.match(html, /el\.commissionSaleValue\.value = formatCurrency\(state\.quoteValues\.subtotal\)/);
  assert.match(html, /el\.commissionFreight\.value = formatCurrency\(state\.quoteValues\.freight \|\| 0\)/);
  assert.match(html, /switchDash\("user"\);[\s\S]*el\.commissionCalculatorPanel\.scrollIntoView/);
});

test("previsão de meta mensal e a trava antiga de elegibilidade PIX foram removidas", () => {
  assert.doesNotMatch(html, /Previsão de Meta Mensal|id="goalMonthly"|id="goalTopPulse"|GOAL_FORECAST_KEY|calculateGoalForecast|updateGoalForecast/);
  assert.doesNotMatch(html, /commissionPixEligible|commissionPixEligibilityRow|commissionPixWarning/);
  assert.doesNotMatch(html, /O prêmio PIX requer pelo menos 80%|pelo menos 80% pagos via PIX|tag “Pix” registrada/);
  const panelStart = html.indexOf('id="commissionCalculatorPanel"');
  const panelEnd = html.indexOf("</section>", panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const userCommissionPanel = html.slice(panelStart, panelEnd);
  assert.match(userCommissionPanel, /id="commissionSplitMode"/);
  assert.match(userCommissionPanel, /id="commissionSplitPixAmount"/);
  assert.match(userCommissionPanel, /id="commissionSplitCardAmount"/);
  assert.match(userCommissionPanel, /id="commissionSplitCardInstallments"/);
});

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

test("simulação de 19/10/2026 atualiza custos e munição industrial dos quatro calibres", () => {
  const start = html.indexOf("      function normalize(value)");
  const end = html.indexOf("\n      const GLOBAL_SEARCH_COMMANDS", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {};
  vm.runInNewContext([
    html.slice(start, end),
    "globalThis.price = applySupplyCatalogPricing;"
  ].join("\n"), sandbox);

  const cases = [
    { calibre: "9mm (9x19mm)", charge: 4.5, projectile: 0.435, factory: 6.8638, powder: 0.33714808074180513, reload: 1.6721480807418052, savedPer1000: 5191.65 },
    { calibre: "38 TPC", charge: 4.2, projectile: 0.435, factory: 6.3243, powder: 0.3146715420256848, reload: 1.649671542025685, savedPer1000: 4674.63 },
    { calibre: "380 ACP", charge: 2.9, projectile: 0.42, factory: 5.4524, powder: 0.2172732075891633, reload: 1.5372732075891633, savedPer1000: 3915.13 },
    { calibre: "38 SPL", charge: 4, projectile: 0.47, factory: 6.4918, powder: 0.29968718288160456, reload: 1.6696871828816047, savedPer1000: 4822.11 }
  ];

  for (const item of cases) {
    const row = sandbox.price({
      calibre: item.calibre,
      carga: 4,
      espoleta: 1.16,
      valorGrain: 0.0679581389,
      projetil: 0.45,
      factoryBox: 500,
      factoryUnit: 5,
      boxQty: 100,
      estojo: 0.25,
      bucha: 0,
      bagos: 0
    });
    assert.equal(row.carga, item.charge);
    assert.equal(row.espoleta, 0.9);
    assert.ok(Math.abs(row.projetil - item.projectile) < 1e-12);
    assert.ok(Math.abs(row.polvora - item.powder) < 1e-12);
    assert.ok(Math.abs(row.recargaUnit - item.reload) < 1e-12);
    assert.ok(Math.abs(row.factoryUnit - item.factory) < 1e-12);
    assert.ok(Math.abs((row.factoryUnit - row.recargaUnit) * 1000 - item.savedPer1000) < 0.01);
    assert.equal(row.estojo, 0);
    assert.equal(row.atualizacao, "19/10/2026");
    assert.match(row.recargaSource, /estojo reutilizado e fora do custo/);
  }

  const unrelated = sandbox.price({
    calibre: "357 Mag", carga: 13.7, espoleta: 1.16, valorGrain: 0.0679581389,
    projetil: 0.45, factoryBox: 676.54, factoryUnit: 6.7654, boxQty: 100,
    estojo: 0, bucha: 0, bagos: 0
  });
  assert.equal(unrelated.atualizacao, "09/2026");
  assert.equal(unrelated.espoleta, 1.2795);
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

  assert.equal(rate("pix", 10), 0.02);
  assert.equal(rate("pix", 10.01), 0.015);
  assert.equal(rate("pix", 11), 0.015);
  assert.equal(rate("pix", 11.01), 0.01);
  assert.equal(rate("pix", 12), 0.01);
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
  assert.ok(Math.abs(sale.premioNegociacao - 184) < 1e-10);
  assert.ok(Math.abs(sale.totalVariavelVenda - 220.8) < 1e-10);
  const exactTenPercent = calculateCommissionValues({
    valorOriginal: 1000,
    descontoPercentual: 10,
    frete: 0,
    formaPagamento: "pix"
  });
  assert.equal(exactTenPercent.valorLiquidoPedido, 900);
  assert.equal(exactTenPercent.premioNegociacao, 18);
  assert.ok(Math.abs(exactTenPercent.totalVariavelVenda - 21.6) < 1e-10);
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
  assert.equal(sale.premioPix, 20);
  assert.equal(sale.premioCartao, 12);
  assert.equal(sale.premioNegociacao, 32);
  assert.equal(sale.comissaoBase, 8);
  assert.equal(sale.totalVariavelVenda, 40);
  assert.equal(sale.percentualPremio, 0.016);

  const discounted = sandbox.calculate({
    valorOriginal: 2000,
    descontoPercentual: 5,
    frete: 0,
    formaPagamento: "split",
    paymentSplit: { pixAmount: 1000, cardAmount: 900, cardInstallments: 6 }
  });
  assert.equal(discounted.valorLiquidoPedido, 1900);
  assert.equal(discounted.valorTotalModalidades, 1900);
  assert.equal(discounted.premioPix, 20);
  assert.equal(discounted.premioCartao, 10.8);
  assert.equal(discounted.premioNegociacao, 30.8);
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

test("matriz de comissão destaca a faixa atual e mostra as regras completas", () => {
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
  const cardCells = [...sandbox.output.innerHTML.matchAll(/<td class="commission-matrix-current" aria-current="true"[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(cardCells.length, 1);
  assert.match(sandbox.output.innerHTML, /<tr><th scope="row">4x a 6x<\/th>/);
  assert.match(sandbox.output.innerHTML, /Até 5%/);
  assert.match(cardCells[0][1], /1\.20%/);
  assert.match(cardCells[0][1], /Orçamento atual/);

  sandbox.render("pix", 10, 1);
  const pixCells = [...sandbox.output.innerHTML.matchAll(/<td class="commission-matrix-current" aria-current="true"[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(pixCells.length, 1);
  assert.match(sandbox.output.innerHTML, /<th scope="row">Até 10%<\/th>/);
  assert.match(pixCells[0][1], /2\.00%/);
  assert.match(sandbox.output.innerHTML, /Até 11%/);
  assert.match(sandbox.output.innerHTML, /Acima de 20%/);

  sandbox.render("card", 5, 6, false);
  assert.doesNotMatch(sandbox.output.innerHTML, /aria-current="true"/);
  assert.match(sandbox.el.commissionRulesCurrent.textContent, /Preencha o valor da venda/);

  sandbox.render("split", 5, 6, true, { pixAmount: 1000, cardAmount: 1000, cardInstallments: 6 });
  const splitCells = [...sandbox.output.innerHTML.matchAll(/<td class="commission-matrix-current" aria-current="true"[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(splitCells.length, 2);
  assert.match(sandbox.output.innerHTML, /<th scope="row">Até 10%<\/th>/);
  assert.match(sandbox.output.innerHTML, /<tr><th scope="row">4x a 6x<\/th>/);
  assert.match(sandbox.output.innerHTML, /cada modalidade/);

  sandbox.render("card", 8, 18);
  const longCardRow = sandbox.output.innerHTML.match(/<tr><th scope="row">16x a 18x<\/th>([\s\S]*?)<\/tr>/)[1];
  assert.match(longCardRow, /0\.30%/);
  assert.match(longCardRow, /0\.00%/);
  assert.equal([...longCardRow.matchAll(/0\.00%/g)].length, 2);
});

test("descontos máximos seguem a tabela PCE e não PCE por marca", () => {
  const rulesStart = html.indexOf("      const DEAL_SAVER_BRANDS = {");
  const rulesEnd = html.indexOf("      function getDealSaverRule()", rulesStart);
  const rendererStart = rulesEnd;
  const rendererEnd = html.indexOf("      function updateDealSaverBrandOptions()", rendererStart);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart && rendererEnd > rendererStart);
  const sandbox = {
    escapeHtml: (value) => String(value),
    formatPercent: (value) => `${Number(value).toFixed(0)}%`
  };
  vm.runInNewContext([
    html.slice(rulesStart, rulesEnd),
    html.slice(rendererStart, rendererEnd),
    "globalThis.rules = DEAL_SAVER_RULES; globalThis.renderPolicy = renderDealSaverPolicyTable;"
  ].join("\n"), sandbox);
  const { pce, nonPce } = sandbox.rules;
  assert.deepEqual([pce.lee.pix.totalRate, pce.lee.card.card1to6, pce.lee.card.card7to12, pce.lee.card.card13to21], [0.2, 0.2, 0.2, 0.1]);
  assert.deepEqual([pce.other.pix.totalRate, pce.other.card.card1to6, pce.other.card.card7to12, pce.other.card.card13to21], [0.2, 0.1, 0.05, 0.05]);
  assert.deepEqual([pce.dillon.pix.totalRate, pce.dillon.card.card1to6], [0.1, 0.05]);
  assert.deepEqual([nonPce.lee.pix.totalRate, nonPce.lee.card.card1to6, nonPce.lee.card.card7to12, nonPce.lee.card.card13to21], [0.2, 0.1, 0.05, 0.05]);
  assert.deepEqual([nonPce.frankford.pix.totalRate, nonPce.recargaClub.pix.totalRate, nonPce.other.card.card13to21], [0.1, 0.1, 0.05]);
  const policy = sandbox.renderPolicy();
  assert.match(policy, /Produtos PCE/);
  assert.match(policy, /Produtos não PCE/);
  assert.match(policy, /Só os 10% do site/);
  assert.match(policy, /20% = 10% do site \+ até 10% adicional/);
  assert.match(policy, /01\/10\/2026/);
  assert.doesNotMatch(html, /dealSaverGroup/);
  assert.match(html, /target: "#dealSaverProductType"/);
});

test("simulador inclui cupom e frete no teto e preserva cupom acima do limite", () => {
  const rulesStart = html.indexOf("      const DEAL_SAVER_BRANDS = {");
  const end = html.indexOf("      function parseQuoteMoneyCandidate(", rulesStart);
  assert.ok(rulesStart >= 0 && end > rulesStart);
  const sandbox = {
    el: {
      dealSaverProductType: { value: "pce" },
      dealSaverBrand: { value: "lee" },
      dealSaverPayment: { value: "card7to12" },
      dealSaverValue: { value: "3000" },
      dealSaverAppliedDiscount: { value: "20" },
      dealSaverFreeFreight: { value: "150" },
      dealSaverEntry: { value: "" }
    },
    escapeHtml: (value) => String(value),
    parseMoney: (value) => Number(value) || 0,
    parsePercentageInput: (value) => Number.parseFloat(String(value).replace("%", "")) || 0,
    formatCurrencyCompact: (value) => `R$${Number(value).toFixed(2)}`,
    formatInstallmentCurrency: (value) => `R$${Number(value).toFixed(2)}`,
    formatPercent: (value) => `${Number(value).toFixed(1)}%`
  };
  vm.runInNewContext([
    html.slice(rulesStart, end),
    "globalThis.render = buildDealSaverHtml;"
  ].join("\n"), sandbox);
  let result = sandbox.render();
  assert.match(result, /deal-saver-danger/);
  assert.match(result, /Teto total: 20\.0% \(R\$600\.00\)/);
  assert.match(result, /Desconto real com frete: R\$750\.00 \(25\.0% do pedido\)/);
  assert.match(result, /Reduza o desconto ou o frete em pelo menos R\$150\.00/);
  assert.match(result, /Desconto adicional ainda permitido: R\$0\.00/);

  sandbox.el.dealSaverPayment.value = "pix";
  sandbox.el.dealSaverAppliedDiscount.value = "";
  sandbox.el.dealSaverFreeFreight.value = "0";
  result = sandbox.render();
  assert.match(result, /Desconto\/cupom aplicado: R\$300\.00 \(10\.0%\)/);
  assert.match(result, /Desconto adicional ainda permitido: R\$300\.00/);

  sandbox.el.dealSaverPayment.value = "card7to12";
  sandbox.el.dealSaverAppliedDiscount.value = "25";
  result = sandbox.render();
  assert.match(result, /deal-saver-warn/);
  assert.match(result, /O cupom continua válido, mas já supera o teto/);
  assert.match(result, /Não conceda desconto adicional nem frete grátis/);
});

test("tutorial de atualização apresenta comissão e nova regra de desconto com demonstração", () => {
  const start = html.indexOf("      const UPDATE_TOUR_STEPS = [");
  const end = html.indexOf("      const UPDATE_TOUR_DEMO_MESSAGE", start);
  assert.ok(start >= 0 && end > start);
  const tourSteps = html.slice(start, end);
  assert.equal((tourSteps.match(/target:/g) || []).length, 3);
  assert.match(html, /2026-10-07-tour-v10/);
  assert.match(tourSteps, /target: "#quoteCommissionDetailsButton"[\s\S]*requiresUserArea: true/);
  assert.match(html, /id="quoteCommissionToggle"[^>]*>Quanto vou ganhar\?/);
  assert.match(tourSteps, /Mostrar detalhes/);
  assert.match(html, /el\.commissionSaleValue\.value = formatCurrency\(state\.quoteValues\.subtotal\)/);
  assert.match(html, /el\.commissionFreight\.value = formatCurrency\(state\.quoteValues\.freight \|\| 0\)/);
  assert.match(html, /switchDash\("user"\);[\s\S]*el\.commissionCalculatorPanel\.scrollIntoView/);
  assert.match(tourSteps, /Confira cupom e frete dentro do limite/);
  assert.match(html, /action === "showDealSaverRules"/);
  assert.match(html, /dealSaverAppliedDiscount: el\.dealSaverAppliedDiscount/);
  assert.match(html, /el\.dealSaverFreeFreight\.value = state\.updateTourSnapshot\.dealSaverFreeFreight/);
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

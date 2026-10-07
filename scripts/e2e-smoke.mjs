/**
 * 端到端冒烟：两个真实浏览器标签页验证离线修订合并。
 * 前置：dev server 运行在 BASE_URL（默认 http://localhost:5171）
 * 运行：node scripts/e2e-smoke.mjs
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5171'
const results = []

function check(name, condition, extra = '') {
  results.push({ name, ok: !!condition })
  console.log(`${condition ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  const pageA = await context.newPage()
  await pageA.goto(BASE_URL)
  await pageA.waitForSelector('.form-canvas > .builder-node')

  const pageB = await context.newPage()
  await pageB.goto(BASE_URL)
  await pageB.waitForSelector('.form-canvas > .builder-node')

  const topNodes = (page) => page.locator('.form-canvas > .builder-node')
  check('两个标签页加载同一基线', (await topNodes(pageA).count()) === (await topNodes(pageB).count()))

  // ---- 1. 标签页 A 改字段标题 → 标签页 B 自动合入 ----
  await topNodes(pageA).first().click()
  await pageA.locator('.el-form-item:has-text("显示标题") input').fill('申请人姓名A')
  await sleep(1300)
  await pageB.waitForFunction(
    () => document.querySelector('.form-canvas > .builder-node .node-label')?.textContent?.includes('申请人姓名A'),
    { timeout: 5000 },
  )
  check('不同标签页的改动自动合入（A 改 → B 可见）', true)

  // ---- 2. 标签页 B 改同一路径 → 冲突留双方值 ----
  await topNodes(pageB).first().click()
  await pageB.locator('.el-form-item:has-text("显示标题") input').fill('申请人姓名B')
  await sleep(1300)
  await pageA.locator('button:has-text("修订与发布")').click()
  await pageA.waitForSelector('.conflict-card', { timeout: 5000 })
  const sideTexts = await pageA.locator('.conflict-side .side-value').allTextContents()
  check('同一路径冲突保留双方值', sideTexts.some((t) => t.includes('申请人姓名A')) && sideTexts.some((t) => t.includes('申请人姓名B')), sideTexts.join(' | '))

  // ---- 3. 采用 B 侧值解决冲突 ----
  await pageA.locator('.conflict-side:has-text("申请人姓名B")').locator('button:has-text("采用该值")').click()
  await sleep(900)
  check('冲突解决后面板显示无冲突', await pageA.locator('.conflict-card').count() === 0)
  await pageB.waitForFunction(
    () => document.querySelector('.form-canvas > .builder-node .node-label')?.textContent?.includes('申请人姓名B'),
    { timeout: 5000 },
  )
  check('解决结果同步到另一标签页', true)
  await pageA.locator('.el-drawer__close-btn').click()
  await sleep(400)

  // ---- 4. 删除被条件引用的字段 → 悬空引用挡住发布 ----
  await pageA.locator('.form-canvas > .builder-node:has-text("申请类型")').first().click()
  await pageA.locator('button:has-text("删除节点")').click()
  await sleep(1300)
  await pageA.locator('button:has-text("修订与发布")').click()
  await pageA.waitForSelector('.dangling-row', { timeout: 5000 })
  const danglingCount = await pageA.locator('.dangling-row').count()
  check('悬空引用列为待修复', danglingCount === 2, `${danglingCount} 处`)
  check('发布被悬空引用挡住', await pageA.locator('button:has-text("发布为基线")').isDisabled())

  // ---- 5. 逐条清除悬空条件 → 发布放行 ----
  for (let i = 0; i < danglingCount; i += 1) {
    await pageA.locator('.dangling-row').first().locator('button:has-text("清除该条件")').click()
    await sleep(1100)
  }
  check('修复后无悬空引用', await pageA.locator('.dangling-row').count() === 0)
  await pageA.locator('button:has-text("发布为基线 v2")').click()
  await sleep(900)
  check('发布成功，基线推进到 v2', await pageA.locator('.canvas-toolbar').textContent().then((t) => t.includes('基线 v2')))
  await pageB.waitForFunction(
    () => document.querySelector('.canvas-toolbar')?.textContent?.includes('基线 v2'),
    { timeout: 5000 },
  )
  check('另一标签页同步到新基线', true)

  // ---- 6. 预览以合并结果为准，无悬空告警 ----
  await pageA.locator('.el-drawer__close-btn').click()
  await pageA.locator('.el-radio-button:has-text("实时预览")').click()
  await pageA.waitForSelector('.preview-card')
  check('预览无悬空告警', await pageA.locator('.el-alert--warning').count() === 0)
  const summary = await pageA.locator('.summary-box').textContent()
  check('预览基于新基线', summary.includes('基线 v2'), summary.trim().slice(0, 60))

  // ---- 7. 旧版无版本草稿迁移 ----
  const legacyContext = await browser.newContext()
  await legacyContext.addInitScript(() => {
    localStorage.setItem('formcraft-schema-v1', JSON.stringify({
      title: '遗留草稿',
      description: '旧版内容',
      nodes: [{ id: 'input_legacy1', type: 'input', label: '旧字段', name: 'oldField', validation: { required: false } }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
  })
  const pageM = await legacyContext.newPage()
  await pageM.goto(BASE_URL)
  await pageM.waitForSelector('.builder-node:has-text("旧字段")', { timeout: 5000 })
  const migrated = await pageM.evaluate(() => ({
    baseline: JSON.parse(localStorage.getItem('formcraft:baseline:v1')),
    legacyGone: localStorage.getItem('formcraft-schema-v1') === null,
    backup: localStorage.getItem('formcraft:legacy-backup:v1'),
  }))
  check('旧稿迁移为基线 v1 且内容保留', migrated.baseline?.version === 1 && migrated.baseline?.schema?.title === '遗留草稿')
  check('旧 key 清除并留有备份', migrated.legacyGone && migrated.backup?.includes('遗留草稿'))
  await legacyContext.close()

  await context.close()
} finally {
  await browser.close()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)

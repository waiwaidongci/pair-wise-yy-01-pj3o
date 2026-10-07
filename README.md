# FormCraft 低代码表单搭建器

基于 Vue 3、TypeScript、Vite、Element Plus、Pinia、Vue Router 与 VueUse 构建。

## 运行

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
```

## 已实现

- 左侧组件库拖入画布，支持输入框、选择器、日期、表格、分组、自定义容器。
- 节点递归渲染与拖拽排序，分组和容器支持嵌套落点。
- 右侧属性面板配置标题、字段名、占位提示、表格列、校验规则和条件显隐。
- 画布 Schema 可导出、导入 JSON。
- 基于快照的撤销重做、删除、复制节点。
- 实时预览页面可填写数据并展示条件显隐、必填、长度、正则和范围校验结果。
- 示例数据与设计状态保存在 Pinia；已完成的 Schema 会写入 localStorage。

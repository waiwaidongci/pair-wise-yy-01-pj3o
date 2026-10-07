import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'designer', component: () => import('../views/DesignerView.vue') },
    { path: '/preview', name: 'preview', component: () => import('../views/PreviewView.vue') },
  ],
})

export default router

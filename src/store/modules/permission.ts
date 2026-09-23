import type { RouteRecordRaw } from 'vue-router';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getRouters } from '@/api/menu';
import ParentView from '@/components/ParentView/index.vue';
import InnerLink from '@/layout/components/InnerLink/index.vue';
import Layout from '@/layout/index.vue';
import auth from '@/plugins/auth';
import router, { constantRoutes, dynamicRoutes } from '@/router';
import store from '@/store';
import { createCustomNameComponent } from '@/utils/createCustomNameComponent';

// 将后端菜单中的组件路径映射到本地页面加载器，避免转换每条路由时扫描全部页面。
const viewModules = import.meta.glob('./../../views/**/*.vue');
const viewModuleMap = new Map<string, () => Promise<any>>();
for (const path in viewModules) {
  const viewsIndex = path.indexOf('/views/');
  if (viewsIndex === -1) continue;
  const viewPath = path.substring(viewsIndex + 7, path.lastIndexOf('.vue'));
  viewModuleMap.set(viewPath, viewModules[path] as () => Promise<any>);
}
export const usePermissionStore = defineStore('permission', () => {
  const routes = ref<RouteRecordRaw[]>([]);
  const addRoutes = ref<RouteRecordRaw[]>([]);
  const defaultRoutes = ref<RouteRecordRaw[]>([]);
  const topbarRouters = ref<RouteRecordRaw[]>([]);
  const sidebarRouters = ref<RouteRecordRaw[]>([]);

  const getRoutes = (): RouteRecordRaw[] => {
    // Vue Router 的路由联合类型经 ref 解包后会丢失部分重定向字段约束。
    return routes.value as RouteRecordRaw[];
  };

  const getDefaultRoutes = (): RouteRecordRaw[] => {
    return defaultRoutes.value as RouteRecordRaw[];
  };

  const getSidebarRoutes = (): RouteRecordRaw[] => {
    return sidebarRouters.value as RouteRecordRaw[];
  };

  const getTopbarRoutes = (): RouteRecordRaw[] => {
    return topbarRouters.value as RouteRecordRaw[];
  };

  const setRoutes = (newRoutes: RouteRecordRaw[]): void => {
    addRoutes.value = newRoutes;
    routes.value = constantRoutes.concat(newRoutes);
  };

  const setDefaultRoutes = (newRoutes: RouteRecordRaw[]): void => {
    defaultRoutes.value = constantRoutes.concat(newRoutes);
  };

  const setTopbarRoutes = (newRoutes: RouteRecordRaw[]): void => {
    topbarRouters.value = newRoutes;
  };

  const setSidebarRouters = (newRoutes: RouteRecordRaw[]): void => {
    sidebarRouters.value = newRoutes;
  };

  /** 从后端菜单生成路由及各导航区域所需的独立路由树。 */
  const generateRoutes = async (): Promise<RouteRecordRaw[]> => {
    const res = await getRouters();
    const data = Array.isArray(res.data) ? res.data : [];
    // 路由转换会替换 component 并整理 children，各导航区域必须使用独立副本。
    const sidebarRoutes = filterAsyncRouter(structuredClone(data));
    const rewriteRoutes = filterAsyncRouter(structuredClone(data), true);
    const topbarRoutes = filterAsyncRouter(structuredClone(data));
    const asyncRoutes = filterDynamicRoutes(dynamicRoutes);
    asyncRoutes.forEach(route => {
      router.addRoute(route);
    });
    setRoutes(rewriteRoutes);
    setSidebarRouters(constantRoutes.concat(sidebarRoutes));
    setDefaultRoutes(sidebarRoutes);
    setTopbarRoutes(topbarRoutes);
    // 路由name重复检查
    duplicateRouteChecker(asyncRoutes, sidebarRoutes);
    return rewriteRoutes;
  };

  /**
   * 将后端菜单的组件路径转换为本地组件，必要时展开 ParentView 子路由。
   * @param menuRoutes 后端返回的菜单路由副本；转换过程会修改其中的节点
   * @param flattenChildren 是否先展开 ParentView 子路由，供动态路由注册使用
   */
  const filterAsyncRouter = (menuRoutes: RouteRecordRaw[], flattenChildren = false): RouteRecordRaw[] => {
    return menuRoutes.map(route => {
      if (flattenChildren && route.children) {
        route.children = filterChildren(route.children);
      }
      // Layout ParentView 组件特殊处理
      if (route.component?.toString() === 'Layout') {
        route.component = Layout;
      } else if (route.component?.toString() === 'ParentView') {
        route.component = ParentView;
      } else if (route.component?.toString() === 'InnerLink') {
        route.component = InnerLink;
      } else {
        route.component = loadView(route.component, route.name as string);
      }
      if (route.children?.length) {
        route.children = filterAsyncRouter(route.children, flattenChildren);
      } else {
        delete route.children;
        delete route.redirect;
      }
      return route;
    });
  };

  /** 展开仅作路径容器的 ParentView，保留最终可访问页面的完整路径。 */
  const filterChildren = (childrenMap: RouteRecordRaw[], lastRouter?: RouteRecordRaw): RouteRecordRaw[] => {
    let children: RouteRecordRaw[] = [];
    childrenMap.forEach(el => {
      el.path = lastRouter ? lastRouter.path + '/' + el.path : el.path;
      if (el.children && el.children.length && el.component?.toString() === 'ParentView') {
        children = children.concat(filterChildren(el.children, el));
      } else {
        children.push(el);
      }
    });
    return children;
  };
  return {
    routes,
    topbarRouters,
    sidebarRouters,
    defaultRoutes,

    getRoutes,
    getDefaultRoutes,
    getSidebarRoutes,
    getTopbarRoutes,

    setRoutes,
    generateRoutes,
    setSidebarRouters
  };
});

/** 仅注册当前用户具有权限或角色的本地动态路由。 */
export const filterDynamicRoutes = (routes: RouteRecordRaw[]) => {
  const res: RouteRecordRaw[] = [];
  routes.forEach(route => {
    if (route.permissions) {
      if (auth.hasPermiOr(route.permissions)) {
        res.push(route);
      }
    } else if (route.roles) {
      if (auth.hasRoleOr(route.roles)) {
        res.push(route);
      }
    }
  });
  return res;
};

/** 按后端组件路径加载页面，并保留菜单配置的路由名称以支持缓存。 */
export const loadView = (view: any, name: string) => {
  const loader = viewModuleMap.get(view);
  if (loader) {
    return createCustomNameComponent(loader, { name });
  }
  return undefined;
};

// 供 setup 外的路由守卫等模块访问同一个 Pinia 实例。
export const usePermissionStoreHook = () => {
  return usePermissionStore(store);
};

interface Route {
  name?: string | symbol;
  path: string;
  children?: Route[];
}

/**
 * 检查本地及后端菜单的叶子路由名称是否重复，避免路由导航命中错误页面。
 * @param localRoutes 本地动态路由
 * @param routes 后端菜单路由
 */
function duplicateRouteChecker(localRoutes: Route[], routes: Route[]) {
  // 展平
  function flatRoutes(routes: Route[]) {
    const res: Route[] = [];
    routes.forEach(route => {
      if (route.children) {
        res.push(...flatRoutes(route.children));
      } else {
        res.push(route);
      }
    });
    return res;
  }

  const allRoutes = flatRoutes([...localRoutes, ...routes]);

  const nameList: string[] = [];
  allRoutes.forEach(route => {
    const name = route.name?.toString() ?? '';
    if (!name) return;
    if (nameList.includes(name)) {
      const message = `路由名称: [${name}] 重复, 会造成 404`;
      console.error(message);
      ElNotification({
        title: '路由名称重复',
        message,
        type: 'error'
      });
      return;
    }
    nameList.push(name);
  });
}

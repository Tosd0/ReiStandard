// ./react 子路径：令牌 → objectURL 的生命周期 hook。
// store 显式作参数传入——不做 context、不做全局单例；宿主想要绑定默认 store 的
// 便捷 hook 或叠加自有取值逻辑（如内置素材解析），在自己那层薄壳里包。

import { useEffect, useState } from 'react';

/**
 * 把字段值解析成可直接用于 <img src> / CSS url() 的字符串。
 *   · 令牌 → 读 Blob 建 objectURL，卸载 / value 变化时 revoke，不泄漏；
 *   · 非令牌（data: / http(s) / 渐变串 / undefined）→ 原样返回；
 *   · 令牌解析完成前返回 undefined（首帧无图；切换令牌时旧图会显示到本次 effect 清空为止，
 *     随后先空一下再出新图，属预期——React 的 effect 在提交后才跑，切换那一次提交仍是旧值）。
 * @param {{ isRef: (v: unknown) => boolean, get: (token: string) => Promise<Blob | null> }} store
 *   createBlobStore 的返回值（只用到 isRef/get，结构化声明以免 allowJs 声明生成翻车）。
 *   须身份稳定——模块级常量或 useMemo 持有；它进了 effect 依赖，每次渲染新建会把读取打成循环。
 * @param {string | undefined | null} value
 * @returns {string | undefined}
 */
export function useBlobUrl(store, value) {
  const [url, setUrl] = useState(store.isRef(value) ? undefined : value ?? undefined);

  useEffect(() => {
    if (!store.isRef(value)) {
      setUrl(value ?? undefined);
      return;
    }
    let alive = true;
    setUrl(undefined); // 令牌变了先清空，别把上一轮 revoke 掉的 URL 交出去（首挂载时 state 本就是 undefined，eagerState 短路，零额外渲染）
    /** @type {string | undefined} */
    let objUrl;
    store.get(value).then((blob) => {
      if (!alive) return;
      if (blob) {
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      } else {
        setUrl(undefined);
      }
    }, () => {
      if (alive) setUrl(undefined);
    });
    return () => {
      alive = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [store, value]);

  return url;
}

/**
 * 构建期注入的包版本。tsup 用 define 把 __AMSG_SERVER_VERSION__ 替换成
 * package.json 的 version（见 tsup.config.js），发布产物里是真实版本号；
 * 直接跑 src（node --test / 本地调试）没有这个替换，typeof 守卫落到
 * '0.0.0-dev'。
 */
/* global __AMSG_SERVER_VERSION__ */
export const SERVER_VERSION =
  typeof __AMSG_SERVER_VERSION__ !== 'undefined' ? __AMSG_SERVER_VERSION__ : '0.0.0-dev';

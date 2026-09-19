/** Адрес воркера, собранного Vite (`import url from './worker?worker&url'`). */
declare module '*?worker&url' {
  const url: string
  export default url
}

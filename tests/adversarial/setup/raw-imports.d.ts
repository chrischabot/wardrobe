// Vite raw imports (byte-exact owner data files).
declare module '*.md?raw' {
  const text: string;
  export default text;
}
declare module '*.csv?raw' {
  const text: string;
  export default text;
}

// Bun embeds these plain browser scripts and styles as text (see assets.ts).
declare module '*.css' { const text: string; export default text }
declare module '*/review-client.js' { const text: string; export default text }
declare module '*/console/ui/theme.js' { const text: string; export default text }

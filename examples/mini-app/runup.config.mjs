// runup config for the example app. A real project keeps this file in its own repository.
export default {
  pageExtensions: ['html'],
  params: { slug: ['hello'] },
  defaultScreens: ['/'],
  // The nav partial is included by the root layout through a template tag, not an import.
  impact: [{ files: 'app/_components/nav.html', screens: 'all' }],
  server: {
    start: 'node server.mjs',
  },
  capture: {
    widths: [390, 1024],
    colorSchemes: ['light', 'dark'],
    settleMs: 0,
  },
  devices: {
    profiles: ['iPhone 15', 'Pixel 7'],
    browsers: ['chromium'],
    colorSchemes: ['light'],
  },
};

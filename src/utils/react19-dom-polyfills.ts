export const applyReact19DomPolyfills = () => {
    // Polyfills for React 19 DOM / jsdom environment
    if (typeof window !== 'undefined') {
        if (!window.matchMedia) {
            window.matchMedia = (query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: () => {},
                removeListener: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                dispatchEvent: () => false,
            });
        }
    }
};

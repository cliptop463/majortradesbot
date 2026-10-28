let previewLogo: string | null = null;
let previewAppName: string | null = null;
let previewShowAppName = true;

const listenersLogo = new Set<(val: string | null) => void>();
const listenersAppName = new Set<(val: string | null) => void>();
const listenersShowAppName = new Set<(val: boolean) => void>();

export const getPreviewLogo = () => previewLogo;
export const getPreviewAppName = () => previewAppName;
export const getPreviewShowAppName = () => previewShowAppName;

export const setPreviewLogo = (val: string | null) => {
    previewLogo = val;
    listenersLogo.forEach(cb => cb(val));
};

export const setPreviewAppName = (val: string | null) => {
    previewAppName = val;
    listenersAppName.forEach(cb => cb(val));
};

export const setPreviewShowAppName = (val: boolean) => {
    previewShowAppName = val;
    listenersShowAppName.forEach(cb => cb(val));
};

export const subscribePreviewLogo = (cb: (val: string | null) => void) => {
    listenersLogo.add(cb);
    return () => listenersLogo.delete(cb);
};

export const subscribePreviewAppName = (cb: (val: string | null) => void) => {
    listenersAppName.add(cb);
    return () => listenersAppName.delete(cb);
};

export const subscribePreviewShowAppName = (cb: (val: boolean) => void) => {
    listenersShowAppName.add(cb);
    return () => listenersShowAppName.delete(cb);
};

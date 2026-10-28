import brandConfig from '../../brand.config.json';

export const getAppName = () => {
    return process.env.NEXT_PUBLIC_DERIV_APP_NAME || brandConfig.platform?.name || 'Deriv Bot';
};

export const getShowAppName = () => {
    return brandConfig.platform?.show_name !== false;
};

export const getLogoCandidates = () => {
    const logoPath = brandConfig.platform?.logo_path;
    if (logoPath) return [logoPath];
    return ['/logo.png', '/logo.svg', '/logo.webp', '/logo.jpeg', '/logo.jpg'];
};

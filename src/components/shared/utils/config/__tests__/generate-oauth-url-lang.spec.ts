/**
 * The template half of #804: the URL builder can append `lang`, but only if the
 * caller reads the language the app is actually rendering in.
 */
jest.mock('@deriv-com/translations', () => ({
    getInitialLanguage: jest.fn(() => 'EN'),
}));

jest.mock('@/services/derivws-accounts.service', () => ({
    DerivWSAccountsService: { getAuthenticatedWebSocketURL: jest.fn() },
}));

const buildAuthorizationUrl = jest.fn(async () => 'https://auth/login');
const buildSignUpUrl = jest.fn(async () => 'https://auth/signup');

jest.mock('@/external/deriv-core', () => ({
    buildAuthorizationUrl: (...args: unknown[]) => buildAuthorizationUrl(...(args as [])),
    buildSignUpUrl: (...args: unknown[]) => buildSignUpUrl(...(args as [])),
    getAuthInfo: jest.fn(() => null),
    getStoredAuthInfo: jest.fn(() => null),
    refreshAccessToken: jest.fn(),
    parseReferralLink: jest.fn(() => null),
    parseLandingParams: jest.fn(() => null),
    resolveReferralViaProxy: jest.fn(async () => null),
}));

import { getInitialLanguage } from '@deriv-com/translations';
import { getStoredAuthInfo, refreshAccessToken } from '@/external/deriv-core';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { generateOAuthURL, getSocketURL } from '../config';

describe('generateOAuthURL language', () => {
    const OLD_ENV = process.env.NEXT_PUBLIC_DERIV_APP_ID;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NEXT_PUBLIC_DERIV_APP_ID = '34hcV8bQLzHVDtLso8juw';
        (getInitialLanguage as jest.Mock).mockReturnValue('EN');
        (getStoredAuthInfo as jest.Mock).mockReturnValue(null);
    });

    afterAll(() => {
        process.env.NEXT_PUBLIC_DERIV_APP_ID = OLD_ENV;
    });

    it.each(['ES', 'FR', 'PT'])('hands the login builder the app language %s', async (code) => {
        (getInitialLanguage as jest.Mock).mockReturnValue(code);
        await generateOAuthURL();
        expect(buildAuthorizationUrl).toHaveBeenCalledWith(expect.objectContaining({ lang: code }));
    });

    it('hands the sign-up builder the same language', async () => {
        (getInitialLanguage as jest.Mock).mockReturnValue('FR');
        await generateOAuthURL('registration');
        expect(buildSignUpUrl).toHaveBeenCalledWith(expect.objectContaining({ lang: 'FR' }));
    });

    it('still passes EN, so a login is never left to resolve its own language', async () => {
        await generateOAuthURL();
        expect(buildAuthorizationUrl).toHaveBeenCalledWith(expect.objectContaining({ lang: 'EN' }));
    });

    it('refreshes an expired saved login before opening its authenticated WebSocket', async () => {
        const authInfo = {
            access_token: 'expired-access-token',
            refresh_token: 'saved-refresh-token',
            expires_at: 1,
        };
        (getStoredAuthInfo as jest.Mock).mockReturnValue(authInfo);
        (refreshAccessToken as jest.Mock).mockResolvedValue({ ...authInfo, access_token: 'refreshed-access-token' });
        (DerivWSAccountsService.getAuthenticatedWebSocketURL as jest.Mock).mockResolvedValue('wss://authenticated');

        await expect(getSocketURL()).resolves.toBe('wss://authenticated');

        expect(refreshAccessToken).toHaveBeenCalledWith('saved-refresh-token', '34hcV8bQLzHVDtLso8juw');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).toHaveBeenCalledWith('refreshed-access-token');
    });
});

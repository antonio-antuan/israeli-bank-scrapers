import { TimeoutError as PuppeteerTimeoutError, type Page } from 'puppeteer';
import { CompanyTypes } from '../../definitions';
import { BaseScraper } from '../base-scraper';
import { BaseScraperWithBrowser, LoginResults } from '../base-scraper-with-browser';
import { ScraperErrorTypes } from '../errors';
import { type ScraperOptions } from '../interface';
import {
  isAccountBlockedText,
  isInvalidPasswordText,
  navigateToLogin,
  parseBalanceDisplay,
  waitForPostLogin,
} from './leumi';

const options = { companyId: CompanyTypes.leumi } as ScraperOptions;
type Credentials = { username: string; password: string };
const credentials: Credentials = { username: 'u', password: 'p' };

describe('isInvalidPasswordText', () => {
  test('matches the original wording', () => {
    expect(isInvalidPasswordText('אחד או יותר מפרטי ההזדהות שמסרת שגויים. ניתן לנסות שוב')).toBe(true);
  });

  test('matches the reworded message on the redesigned logon page', () => {
    expect(isInvalidPasswordText('שגיאה\nאחד או יותר מפרטי ההזדהות שהוקלדו שגויים, ניתן לנסות שוב')).toBe(true);
  });

  test('does not match help text that only mentions the identification details', () => {
    expect(isInvalidPasswordText('אחד או יותר מפרטי ההזדהות נדרשים לכניסה לחשבון')).toBe(false);
  });
});

describe('isAccountBlockedText', () => {
  test('matches the blocked subscription notice', () => {
    expect(isAccountBlockedText('המנוי חסום. יש לפנות לסניף')).toBe(true);
  });

  test('does not match an ordinary page', () => {
    expect(isAccountBlockedText('ברוכים הבאים')).toBe(false);
  });
});

describe('parseBalanceDisplay', () => {
  test('keeps thousands instead of stopping at the separator', () => {
    expect(parseBalanceDisplay('1,234.56')).toBe(1234.56);
  });

  test('reads a leading minus', () => {
    expect(parseBalanceDisplay('-12,000.10')).toBe(-12000.1);
  });

  test('reads a trailing minus', () => {
    expect(parseBalanceDisplay('1,234.56-')).toBe(-1234.56);
  });

  test('ignores a shekel sign and direction marks', () => {
    expect(parseBalanceDisplay('‎₪ 1,234.56')).toBe(1234.56);
  });

  test('accepts a number', () => {
    expect(parseBalanceDisplay(42.5)).toBe(42.5);
  });

  test('returns undefined when the field is missing', () => {
    expect(parseBalanceDisplay(undefined)).toBeUndefined();
    expect(parseBalanceDisplay('')).toBeUndefined();
  });

  test.each(['abc', '1.234,56', '12,34', '--5', '-5-', '1 2 3x'])('refuses %p', value => {
    expect(() => parseBalanceDisplay(value)).toThrow('unexpected BalanceDisplay format');
  });

  test('refuses an object', () => {
    expect(() => parseBalanceDisplay({ amount: 1 })).toThrow('unexpected BalanceDisplay format');
  });
});

describe('waitForPostLogin', () => {
  const timeout = () => Promise.reject(new PuppeteerTimeoutError('timed out'));

  test('an early failing branch does not abort a branch that later succeeds', async () => {
    const page = {
      waitForSelector: jest.fn(timeout),
      waitForFunction: jest.fn(() => new Promise(resolve => setTimeout(resolve, 20))),
    };
    await expect(waitForPostLogin(page as unknown as Page)).resolves.toBeUndefined();
  });

  test('rethrows a timeout as a timeout when every branch fails', async () => {
    const page = { waitForSelector: jest.fn(timeout), waitForFunction: jest.fn(timeout) };
    await expect(waitForPostLogin(page as unknown as Page)).rejects.toBeInstanceOf(PuppeteerTimeoutError);
  });

  test('gives every branch the same 60 second deadline', async () => {
    const page = { waitForSelector: jest.fn(timeout), waitForFunction: jest.fn(timeout) };
    await waitForPostLogin(page as unknown as Page).catch(() => undefined);
    for (const [, selectorOptions] of page.waitForSelector.mock.calls as unknown as [string, { timeout: number }][]) {
      expect(selectorOptions.timeout).toBe(60000);
    }
    expect(page.waitForFunction.mock.calls[0]).toEqual([
      expect.any(Function),
      { timeout: 60000 },
      expect.any(String),
      expect.any(String),
    ]);
  });
});

describe('navigateToLogin', () => {
  const createPage = (navigation: () => Promise<unknown>) => ({
    goto: jest.fn().mockResolvedValue(null),
    waitForNavigation: jest.fn(navigation),
    waitForSelector: jest.fn().mockResolvedValue({}),
  });

  test('carries on to the login fields when the loaded logon page does not navigate again', async () => {
    const page = createPage(() => Promise.reject(new PuppeteerTimeoutError('no navigation')));
    await expect(navigateToLogin(page as unknown as Page)).resolves.toBeUndefined();
    expect(page.waitForSelector).toHaveBeenCalledWith('input[placeholder="סיסמה"]', expect.anything());
  });

  test('bounds the wait for a further navigation', async () => {
    const page = createPage(() => Promise.resolve(null));
    await navigateToLogin(page as unknown as Page);
    expect(page.waitForNavigation).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15000 }));
  });

  test('does not hide other navigation errors', async () => {
    const page = createPage(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')));
    await expect(navigateToLogin(page as unknown as Page)).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });
});

describe('BaseScraper error mapping', () => {
  class ThrowingScraper extends BaseScraper<Credentials> {
    constructor(private error: Error) {
      super(options);
    }

    protected login(): Promise<never> {
      return Promise.reject(this.error);
    }
  }

  test('reports a Puppeteer timeout as TIMEOUT', async () => {
    const result = await new ThrowingScraper(new PuppeteerTimeoutError('waiting failed')).scrape(credentials);
    expect(result.errorType).toBe(ScraperErrorTypes.Timeout);
  });

  test('still reports other errors as GENERIC', async () => {
    const result = await new ThrowingScraper(new Error('boom')).scrape(credentials);
    expect(result.errorType).toBe(ScraperErrorTypes.Generic);
  });
});

describe('BaseScraperWithBrowser', () => {
  type Internals = {
    page: unknown;
    cleanups: Array<() => Promise<void>>;
    handleLoginResult: (result: LoginResults) => { success: boolean; errorType?: ScraperErrorTypes };
    terminate: (success: boolean) => Promise<void>;
  };
  const create = (extra: Partial<ScraperOptions> = {}) =>
    new BaseScraperWithBrowser<Credentials>({ ...options, ...extra }) as unknown as Internals;

  test('reports a detected blocked account as ACCOUNT_BLOCKED', () => {
    const result = create().handleLoginResult(LoginResults.AccountBlocked);
    expect(result).toEqual(expect.objectContaining({ success: false, errorType: ScraperErrorTypes.AccountBlocked }));
  });

  test('a failed failure screenshot neither skips cleanup nor throws', async () => {
    const scraper = create({ storeFailureScreenShotPath: '/nonexistent/shot.png' });
    const cleanup = jest.fn().mockResolvedValue(undefined);
    scraper.page = { screenshot: jest.fn().mockRejectedValue(new Error('ENOENT')) };
    scraper.cleanups = [cleanup];
    await expect(scraper.terminate(false)).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalled();
  });
});

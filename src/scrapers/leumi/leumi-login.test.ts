import { TimeoutError as PuppeteerTimeoutError, type Page } from 'puppeteer';
import { CompanyTypes } from '../../definitions';
import { BaseScraper } from '../base-scraper';
import { BaseScraperWithBrowser, LoginResults } from '../base-scraper-with-browser';
import { ScraperErrorTypes } from '../errors';
import { type ScraperOptions } from '../interface';
import moment from 'moment';
import LeumiScraper, {
  fetchTransactionsForAccount,
  isAccountBlockedText,
  isInvalidPasswordText,
  navigateToLogin,
  pageRoute,
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

  test('tolerates line breaks, direction marks and no or two words before the verdict', () => {
    expect(isInvalidPasswordText('אחד או יותר\nמפרטי\u200f ההזדהות שמסרת שגויים')).toBe(true);
    expect(isInvalidPasswordText('אחד או יותר מפרטי ההזדהות שגויים')).toBe(true);
    expect(isInvalidPasswordText('אחד או יותר מפרטי ההזדהות אשר הוקלדו שגויים')).toBe(true);
  });

  test('does not match help text that only mentions the identification details', () => {
    expect(isInvalidPasswordText('אחד או יותר מפרטי ההזדהות נדרשים לכניסה לחשבון')).toBe(false);
  });
});

describe('isAccountBlockedText', () => {
  test('matches the blocked subscription notice', () => {
    expect(isAccountBlockedText('המנוי חסום. יש לפנות לסניף')).toBe(true);
  });

  test('tolerates a line break inside the notice', () => {
    expect(isAccountBlockedText('המנוי\nחסום')).toBe(true);
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

  test('reads a Unicode minus on either side', () => {
    expect(parseBalanceDisplay('\u221212.50')).toBe(-12.5);
    expect(parseBalanceDisplay('12.50\u2212')).toBe(-12.5);
  });

  test('reads zero, integers and a leading-dot fraction', () => {
    expect(parseBalanceDisplay('0')).toBe(0);
    expect(parseBalanceDisplay('1,234')).toBe(1234);
    expect(parseBalanceDisplay('.5')).toBe(0.5);
  });

  test('accepts a number', () => {
    expect(parseBalanceDisplay(42.5)).toBe(42.5);
  });

  test('returns undefined when the field is missing', () => {
    expect(parseBalanceDisplay(undefined)).toBeUndefined();
    expect(parseBalanceDisplay('')).toBeUndefined();
  });

  test.each(['abc', '1.234,56', '12,34', '--5', '-5-', '1 2 3', '1 2 3x', '9'.repeat(400)])('refuses %p', value => {
    expect(() => parseBalanceDisplay(value)).toThrow('unexpected BalanceDisplay format');
  });

  test('refuses an object', () => {
    expect(() => parseBalanceDisplay({ amount: 1 })).toThrow('unexpected BalanceDisplay format');
  });
});

const HOME = 'https://hb2.bankleumi.co.il/eBanking/SO/SPA.aspx#/HPSummary';

describe('pageRoute', () => {
  test('keeps the path and hash route', () => {
    expect(pageRoute('https://hb2.bankleumi.co.il/eBanking/SO/SPA.aspx#/ts/CardsWorld')).toBe(
      '/eBanking/SO/SPA.aspx#/ts/CardsWorld',
    );
  });

  test('drops query strings and unexpected characters', () => {
    expect(pageRoute('https://hb2.bankleumi.co.il/eBanking/a b.aspx?u=1#/x"<y>?WidgetPar=1')).toBe(
      '/eBanking/a20b.aspx#/x223Cy3E',
    );
  });

  test('survives a URL it cannot parse', () => {
    expect(pageRoute('not a url')).toBe('an unparsable URL');
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
    const page = { waitForSelector: jest.fn(timeout), waitForFunction: jest.fn(timeout), url: () => HOME };
    await expect(waitForPostLogin(page as unknown as Page)).rejects.toBeInstanceOf(PuppeteerTimeoutError);
  });

  test('names the unrecognized page route without its query string', async () => {
    const page = {
      waitForSelector: jest.fn(timeout),
      waitForFunction: jest.fn(timeout),
      url: () => 'https://hb2.bankleumi.co.il/eBanking/SO/SPA.aspx?sid=secret#/HPSummary?x=1',
    };
    await expect(waitForPostLogin(page as unknown as Page)).rejects.toThrow(
      'no known post-login page at /eBanking/SO/SPA.aspx#/HPSummary',
    );
  });

  test('a non-timeout failure is rethrown unchanged', async () => {
    const boom = new Error('target closed');
    const page = {
      waitForSelector: jest.fn(() => Promise.reject(boom)),
      waitForFunction: jest.fn(() => Promise.reject(boom)),
      url: () => HOME,
    };
    await expect(waitForPostLogin(page as unknown as Page)).rejects.toBe(boom);
  });

  test('the logout button alone is enough on the HPSummary variant', async () => {
    const page = {
      waitForSelector: jest.fn(timeout),
      waitForFunction: jest.fn(),
      url: () => HOME,
    };
    page.waitForFunction.mockImplementationOnce(timeout).mockImplementationOnce(() => Promise.resolve());
    await expect(waitForPostLogin(page as unknown as Page)).resolves.toBeUndefined();
  });

  describe('the logged-in check that runs in the page', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    afterEach(() => {
      delete globals.window;
      delete globals.document;
    });

    const loggedInCheck = async () => {
      const page = { waitForSelector: jest.fn(timeout), waitForFunction: jest.fn(timeout), url: () => HOME };
      await waitForPostLogin(page as unknown as Page).catch(() => undefined);
      const [check, , ...args] = page.waitForFunction.mock.calls[1] as unknown as [
        (...a: string[]) => boolean,
        unknown,
        ...string[],
      ];
      return (pathname: string, text: string) => {
        globals.window = { location: { pathname } };
        globals.document = { body: { innerText: text } };
        return check(...args);
      };
    };

    test('accepts an eBanking page with the logout button', async () => {
      const check = await loggedInCheck();
      expect(check('/eBanking/SO/SPA.aspx', 'בוקר טוב\nהתנתקות')).toBe(true);
      expect(check('/eBanking/ForeignCurrency/DisplayForeignAccountsActivity.aspx', 'התנתקות')).toBe(true);
    });

    test('refuses the logon page and a page without the logout button', async () => {
      const check = await loggedInCheck();
      expect(check('/authenticate/logon', 'התנתקות')).toBe(false);
      expect(check('/eBanking/SO/SPA.aspx', 'טוען...')).toBe(false);
    });
  });

  test('gives every branch the same 60 second deadline', async () => {
    const page = { waitForSelector: jest.fn(timeout), waitForFunction: jest.fn(timeout), url: () => HOME };
    await waitForPostLogin(page as unknown as Page).catch(() => undefined);
    for (const [, selectorOptions] of page.waitForSelector.mock.calls as unknown as [string, { timeout: number }][]) {
      expect(selectorOptions.timeout).toBe(60000);
    }
    expect(page.waitForFunction).toHaveBeenCalledTimes(2);
    for (const call of page.waitForFunction.mock.calls as unknown[][]) {
      expect(call).toEqual([expect.any(Function), { timeout: 60000 }, expect.any(String), expect.any(String)]);
    }
  });
});

describe('login result order', () => {
  const results = () =>
    new LeumiScraper(options).getLoginOptions({ username: 'u', password: 'p' }).possibleResults as Record<
      string,
      ((o: { page: Page }) => Promise<boolean>)[]
    >;
  const classify = async (text: string) => {
    const page = {
      evaluate: jest.fn().mockResolvedValue(text),
      $: jest.fn().mockResolvedValue(null),
    } as unknown as Page;
    for (const [result, checks] of Object.entries(results())) {
      for (const check of checks) {
        if (typeof check === 'function' && (await check({ page }))) {
          return result;
        }
      }
    }
    return undefined;
  };

  test('a blocked notice wins over a password error left on the page', async () => {
    await expect(classify('אחד או יותר מפרטי ההזדהות שמסרת שגויים\nהמנוי חסום')).resolves.toBe(
      LoginResults.AccountBlocked,
    );
  });

  test('a password error alone is reported as such', async () => {
    await expect(classify('אחד או יותר מפרטי ההזדהות שהוקלדו שגויים')).resolves.toBe(LoginResults.InvalidPassword);
  });
});

describe('fetchTransactionsForAccount', () => {
  afterEach(() => jest.useRealTimers());

  test('catches a filter response that arrives while the click is still in flight', async () => {
    jest.useFakeTimers();
    const response = {
      url: () =>
        'https://hb2.bankleumi.co.il/ChannelWCF/Broker.svc/ProcessRequest?moduleName=UC_SO_27_GetBusinessAccountTrx',
      request: () => ({ method: () => 'POST' }),
      json: () =>
        Promise.resolve({
          jsonResp: JSON.stringify({
            BalanceDisplay: '1,234.56',
            TodayTransactionsItems: [],
            HistoryTransactionsItems: [],
          }),
        }),
    };
    let listener: ((r: typeof response) => boolean) | undefined;
    let deliver: ((r: typeof response) => void) | undefined;
    const page = {
      waitForSelector: jest.fn().mockResolvedValue({}),
      focus: jest.fn().mockResolvedValue(undefined),
      type: jest.fn().mockResolvedValue(undefined),
      $eval: jest.fn((selector: string) => {
        // The response is emitted during the filter click; only a listener that already exists sees it.
        if (selector === "button[aria-label='סנן']" && listener?.(response)) {
          deliver?.(response);
        }
        return Promise.resolve();
      }),
      waitForResponse: jest.fn(
        (predicate: (r: typeof response) => boolean) =>
          new Promise((resolve, reject) => {
            listener = predicate;
            deliver = resolve;
            setTimeout(() => reject(new PuppeteerTimeoutError('no response')), 30000);
          }),
      ),
    };
    const result = fetchTransactionsForAccount(page as unknown as Page, moment('2026-01-01'), '123-456789/01', options);
    await jest.advanceTimersByTimeAsync(31000);
    await expect(result).resolves.toEqual(expect.objectContaining({ balance: 1234.56, txns: [] }));
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

import moment, { type Moment } from 'moment';
import { TimeoutError as PuppeteerTimeoutError, type Page } from 'puppeteer';
import { SHEKEL_CURRENCY } from '../../constants';
import { getDebug } from '../../helpers/debug';
import { clickButton, fillInput, pageEvalAll, waitUntilElementFound } from '../../helpers/elements-interactions';
import { fetchGetWithinPage } from '../../helpers/fetch';
import { getRawTransaction } from '../../helpers/transactions';
import { waitForNavigation } from '../../helpers/navigation';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../../transactions';
import { BaseScraperWithBrowser, LoginResults, type LoginOptions } from '../base-scraper-with-browser';
import { type ScraperOptions, type ScraperScrapingResult } from '../interface';
import { fetchForeignCurrencyAccounts } from './leumi-forex';

const debug = getDebug('leumi');
const BASE_URL = 'https://hb2.bankleumi.co.il';
const LOGIN_URL = `${BASE_URL}/authenticate/logon`;
const TRANSACTIONS_URL = `${BASE_URL}/eBanking/SO/SPA.aspx#/ts/BusinessAccountTrx?WidgetPar=1`;
const FILTERED_TRANSACTIONS_URL = `${BASE_URL}/ChannelWCF/Broker.svc/ProcessRequest?moduleName=UC_SO_27_GetBusinessAccountTrx`;
const ACCOUNT_NUMBER_SELECTOR = 'app-masked-number-combo span.display-number-li';
const SAVINGS_URL = `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile/accounts/1/Deposits?operationList=true`;

const DATE_FORMAT = 'DD.MM.YY';
const ACCOUNT_BLOCKED_MSG = 'המנוי חסום';
// Leumi rewords the middle of this message occasionally (שמסרת/שהוקלדו); require the stable prefix and the
// "wrong" verdict so unrelated help text that mentions the identification details does not match.
const INVALID_PASSWORD_PATTERN = 'אחד או יותר מפרטי ההזדהות\\s+\\S+\\s+שגויים';
const LOGIN_WAIT_TIMEOUT = 60000;
const CHANGE_PASSWORD_MODAL_SELECTOR = 'form input[name="newPwd"]';

interface SavingsDepositItem {
  index: string;
  depositId: string;
  depositIndex: number;
  depositSourceId: string;
  type: number;
  displayName: string;
  productName: string;
  friendlyAccountName: string;
  deepLink: string;
  isForeclosed: boolean;
  asOfDate: string;
  createDate: string;
  exitPointDate: string;
  currentBalance: number;
  initialAmount: number | null;
  installmentsSavingFlag: boolean;
  marginRate: string;
  productInterestType: string | null;
  productLinkageType: string | null;
  sourceSystem: string;
  depositNumber: string;
  relatedAccountNumber: string;
  withdrawalRequestText: string | null;
  WithdrawalAvailableFrequency: string | null;
  depositOperationsItems: any[];
}

interface SavingsAccountData {
  totalDepositsAndSavingsBalance: number;
  previousBusinessDayDate: string;
  depositsAndSavingsItems: SavingsDepositItem[];
  operationsItemsTotal: string;
  operationsListItems: any[];
}

export function isInvalidPasswordText(text: string): boolean {
  return new RegExp(INVALID_PASSWORD_PATTERN).test(text);
}

export function isAccountBlockedText(text: string): boolean {
  return text.includes(ACCOUNT_BLOCKED_MSG);
}

// innerText skips hidden elements, so an error template that is not displayed does not count.
async function getVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '');
}

// BalanceDisplay is a display string; accept "1,234.56", "-1,234.56" and the trailing-minus "1,234.56-" forms and
// refuse anything else instead of letting parseFloat stop at the first separator.
export function parseBalanceDisplay(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('unexpected BalanceDisplay format');
  }
  const normalized = String(value).replace(/[\s\u200e\u200f\u20aa]/g, '');
  // Commas only as groups of three before the decimal point, so "1.234,56" is refused rather than misread.
  const match = /^(-?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(-?)$/.exec(normalized);
  if (!match || (match[1] && match[3])) {
    throw new Error('unexpected BalanceDisplay format');
  }
  const amount = Number(match[2].replace(/,/g, ''));
  return match[1] || match[3] ? -amount : amount;
}

function getPossibleLoginResults() {
  const urls: LoginOptions['possibleResults'] = {
    [LoginResults.Success]: [/ebanking\/SO\/SPA.aspx/i],
    [LoginResults.InvalidPassword]: [
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        // The svg#Capa_1 icon anchor no longer exists on the redesigned
        // logon page; detect the failure message in the visible page text.
        return isInvalidPasswordText(await getVisibleText(options.page));
      },
    ],
    [LoginResults.AccountBlocked]: [
      // NOTICE - might not be relevant starting the Leumi re-design during 2022 Sep
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        const errorMessage = await pageEvalAll(options.page, '.errHeader', '', label => {
          return (label[0] as HTMLElement)?.innerText;
        });

        return (
          !!errorMessage?.startsWith(ACCOUNT_BLOCKED_MSG) || isAccountBlockedText(await getVisibleText(options.page))
        );
      },
    ],
    [LoginResults.ChangePassword]: [
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        return !!(await options.page.$(CHANGE_PASSWORD_MODAL_SELECTOR));
      },
    ],
  };
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: 'input[placeholder="שם משתמש"]', value: credentials.username },
    { selector: 'input[placeholder="סיסמה"]', value: credentials.password },
  ];
}

function extractTransactionsFromPage(
  transactions: any[],
  status: TransactionStatuses,
  options?: ScraperOptions,
): Transaction[] {
  if (transactions === null || transactions.length === 0) {
    return [];
  }

  const result: Transaction[] = transactions.map(rawTransaction => {
    const date = moment(rawTransaction.DateUTC).milliseconds(0).toISOString();
    const newTransaction: Transaction = {
      status,
      type: TransactionTypes.Normal,
      date,
      processedDate: date,
      description: rawTransaction.Description || '',
      identifier: rawTransaction.ReferenceNumberLong,
      memo: rawTransaction.AdditionalData || '',
      originalCurrency: SHEKEL_CURRENCY,
      chargedAmount: rawTransaction.Amount,
      originalAmount: rawTransaction.Amount,
    };

    if (options?.includeRawTransaction) {
      newTransaction.rawTransaction = getRawTransaction(rawTransaction);
    }

    return newTransaction;
  });

  return result;
}

function hangProcess(timeout: number) {
  return new Promise<void>(resolve => {
    setTimeout(() => {
      resolve();
    }, timeout);
  });
}

async function clickByXPath(page: Page, xpath: string): Promise<void> {
  await page.waitForSelector(xpath, { timeout: 30000, visible: true });
  const elm = await page.$$(xpath);
  await elm[0].click();
}

function removeSpecialCharacters(str: string): string {
  return str.replace(/[^0-9/-]/g, '');
}

async function fetchTransactionsForAccount(
  page: Page,
  startDate: Moment,
  accountId: string,
  options: ScraperOptions,
): Promise<TransactionsAccount> {
  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  await waitUntilElementFound(page, 'button[title="חיפוש מתקדם"]', true);
  await clickButton(page, 'button[title="חיפוש מתקדם"]');
  await waitUntilElementFound(page, 'bll-radio-button', true);
  await clickButton(page, 'bll-radio-button:not([checked])');

  await waitUntilElementFound(page, 'input[formcontrolname="txtInputFrom"]', true);

  await fillInput(page, 'input[formcontrolname="txtInputFrom"]', startDate.format(DATE_FORMAT));

  // we must blur the from control otherwise the search will use the previous value
  await page.focus("button[aria-label='סנן']");

  // Listen before clicking: a fast response would otherwise arrive before the listener exists.
  const [finalResponse] = await Promise.all([
    page.waitForResponse(response => {
      return response.url() === FILTERED_TRANSACTIONS_URL && response.request().method() === 'POST';
    }),
    clickButton(page, "button[aria-label='סנן']"),
  ]);

  const responseJson: any = await finalResponse.json();

  const accountNumber = accountId.replace('/', '_').replace(/[^\d-_]/g, '');

  const response = JSON.parse(responseJson.jsonResp);

  const pendingTransactions = response.TodayTransactionsItems;
  const transactions = response.HistoryTransactionsItems;
  const balance = parseBalanceDisplay(response.BalanceDisplay);

  const pendingTxns = extractTransactionsFromPage(pendingTransactions, TransactionStatuses.Pending, options);
  const completedTxns = extractTransactionsFromPage(transactions, TransactionStatuses.Completed, options);
  const txns = [...pendingTxns, ...completedTxns];

  return {
    accountNumber,
    balance,
    txns,
  };
}

async function fetchRegularAccounts(
  scraper: LeumiScraper,
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  await scraper.navigateTo(TRANSACTIONS_URL);
  return fetchTransactions(page, startDate, options);
}

async function getSavingsAccounts(page: Page, accountId: string): Promise<TransactionsAccount[]> {
  debug('========== FETCHING SAVINGS ACCOUNTS ==========');
  debug('Account: %s', accountId);

  const accounts: TransactionsAccount[] = [];

  try {
    debug('Trying savings URL: %s', SAVINGS_URL);

    const savingsData = await fetchGetWithinPage<SavingsAccountData>(page, SAVINGS_URL);
    if (!savingsData || !savingsData.depositsAndSavingsItems || savingsData.depositsAndSavingsItems.length === 0) {
      debug('No savings accounts found for account %s', accountId);
      return [];
    }
    debug('✓ Found %d savings deposits', savingsData.depositsAndSavingsItems.length);

    // Create a separate account for each individual deposit
    for (const deposit of savingsData.depositsAndSavingsItems) {
      const balance = deposit.currentBalance;
      const savingsAccountNumber = `${accountId}-${deposit.depositId}`;

      accounts.push({
        accountNumber: savingsAccountNumber,
        savingsAccount: true,
        balance,
        txns: [],
      });

      debug(
        'Added savings account %s with balance %s (product: %s)',
        savingsAccountNumber,
        balance,
        deposit.productName,
      );
    }
  } catch (error) {
    debug('  - Error fetching savings accounts: %s', error);
  }

  debug('Returning %d savings accounts', accounts.length);
  return accounts;
}

async function fetchTransactions(
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  const accounts: TransactionsAccount[] = [];

  // The transactions page is reached through a hash change on the SPA, so navigation resolves before the
  // account selector is rendered. Wait for it instead of failing with "Failed to extract or parse the account number".
  try {
    await waitUntilElementFound(page, ACCOUNT_NUMBER_SELECTOR, false, 30000);
  } catch {
    debug('account number selector was not rendered within 30 seconds');
  }

  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  const accountsIds = (await page.evaluate(
    selector => Array.from(document.querySelectorAll(selector), e => e.textContent),
    ACCOUNT_NUMBER_SELECTOR,
  )) as string[];

  // due to a bug, the altered value might include undesired signs like & that should be removed

  if (!accountsIds.length) {
    throw new Error('Failed to extract or parse the account number');
  }

  for (const accountId of accountsIds) {
    if (accountsIds.length > 1) {
      // get list of accounts and check accountId
      await clickByXPath(page, 'xpath///*[contains(@class, "number") and contains(@class, "combo-inner")]');
      await clickByXPath(page, `xpath///span[contains(text(), '${accountId}')]`);
    }

    accounts.push(await fetchTransactionsForAccount(page, startDate, removeSpecialCharacters(accountId), options));
  }

  return accounts;
}

async function fetchSavingsAccounts(
  page: Page,
  regularAccounts: TransactionsAccount[],
): Promise<TransactionsAccount[]> {
  const allSavingsAccounts: TransactionsAccount[] = [];
  const regularAccountCount = regularAccounts.length;

  for (let i = 0; i < regularAccountCount; i++) {
    try {
      const savingsAccounts = await getSavingsAccounts(page, regularAccounts[i].accountNumber);
      allSavingsAccounts.push(...savingsAccounts);
      debug('Added %d savings accounts to results', savingsAccounts.length);
    } catch (error) {
      debug('Error fetching savings accounts for %s: %s', regularAccounts[i].accountNumber, error);
    }
  }

  return allSavingsAccounts;
}

export async function navigateToLogin(page: Page): Promise<void> {
  debug('navigating directly to login page');
  await page.goto(LOGIN_URL);
  debug('waiting for page to be loaded (networkidle2)');
  // The logon page may or may not navigate again after loading; the login fields below are the real gate.
  try {
    await waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) {
    if (!(e instanceof PuppeteerTimeoutError)) {
      throw e;
    }
    debug('no further navigation after the logon page loaded');
  }
  debug('waiting for components of login to enter credentials');
  await Promise.all([
    waitUntilElementFound(page, 'input[placeholder="שם משתמש"]', true),
    waitUntilElementFound(page, 'input[placeholder="סיסמה"]', true),
    waitUntilElementFound(page, 'button[type="submit"]', true),
  ]);
}

// Resolves on the first terminal login state. Promise.any keeps a branch that gives up early from aborting the
// others; only when every branch fails is the first failure rethrown, so a timeout stays a TimeoutError.
export async function waitForPostLogin(page: Page): Promise<void> {
  try {
    await Promise.any([
      waitUntilElementFound(page, 'a[title="דלג לחשבון"]', true, LOGIN_WAIT_TIMEOUT),
      waitUntilElementFound(page, 'div.main-content', false, LOGIN_WAIT_TIMEOUT),
      page.waitForFunction(
        (pattern: string, blocked: string) => {
          const text = document.body?.innerText ?? '';
          return new RegExp(pattern).test(text) || text.includes(blocked);
        },
        { timeout: LOGIN_WAIT_TIMEOUT },
        INVALID_PASSWORD_PATTERN,
        ACCOUNT_BLOCKED_MSG,
      ),
      waitUntilElementFound(page, CHANGE_PASSWORD_MODAL_SELECTOR, true, LOGIN_WAIT_TIMEOUT),
    ]);
  } catch (e) {
    throw e instanceof AggregateError ? e.errors[0] : e;
  }
}

type ScraperSpecificCredentials = { username: string; password: string };

class LeumiScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: LOGIN_URL,
      fields: createLoginFields(credentials),
      submitButtonSelector: "button[type='submit']",
      checkReadiness: async () => navigateToLogin(this.page),
      postAction: async () => waitForPostLogin(this.page),
      possibleResults: getPossibleLoginResults(),
    };
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    const minimumStartMoment = moment().subtract(3, 'years').add(1, 'day');
    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(minimumStartMoment, moment(startDate));

    const accounts = await fetchRegularAccounts(this, this.page, startMoment, this.options);
    const savingsAccounts = await fetchSavingsAccounts(this.page, accounts);
    accounts.push(...savingsAccounts);

    const foreignCurrencyAccounts = await fetchForeignCurrencyAccounts(this.page, startMoment, this.options);
    accounts.push(...foreignCurrencyAccounts);

    return {
      success: true,
      accounts,
    };
  }
}

export default LeumiScraper;

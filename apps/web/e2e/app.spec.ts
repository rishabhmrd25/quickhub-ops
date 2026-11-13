import { expect, test, type Page } from '@playwright/test';

type Role = 'manager' | 'picker' | 'viewer';

async function login(page: Page, role: Role, path = '/') {
  await page.goto(path);
  await page.getByLabel('Email').fill(`${role}@quickhub.dev`);
  await page.getByLabel('Password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('connection')).toHaveText('Live');
}

const rows = (page: Page) => page.getByTestId('order-row');
const statusChip = (page: Page, name: string) => page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: new RegExp(`^${name}`) });

test.describe('sign in', () => {
  test('sends signed-out users to login, then back to the page they wanted', async ({ page }) => {
    await login(page, 'manager', '/inventory');
    await expect(page).toHaveURL(/\/inventory$/);
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  });

  test('shows an error for a wrong password and validates the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter a valid email')).toBeVisible();

    await page.getByLabel('Email').fill('manager@quickhub.dev');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Wrong email or password')).toBeVisible();
  });

  test('signing out clears the session', async ({ page }) => {
    await login(page, 'manager');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('roles', () => {
  test('manager can create orders and adjust stock', async ({ page }) => {
    await login(page, 'manager');
    await expect(page.getByRole('link', { name: '+ New order' })).toBeVisible();
    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(page.getByRole('columnheader', { name: 'Adjust stock' })).toBeVisible();
  });

  test('viewer is read-only, and is blocked from the new-order page', async ({ page }) => {
    await login(page, 'viewer');
    await expect(page.getByRole('link', { name: '+ New order' })).toHaveCount(0);

    await statusChip(page, 'New').click();
    await rows(page).first().click();
    const drawer = page.getByTestId('order-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: /Start picking|Cancel order/ })).toHaveCount(0);
    await expect(drawer.getByRole('combobox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();

    await page.goto('/inventory');
    await expect(page.getByTestId('inventory-row').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Adjust stock' })).toHaveCount(0);
  });

  test('picker sees only their own orders and cannot cancel', async ({ page }) => {
    await login(page, 'picker');
    await expect(rows(page).first()).toBeVisible();
    const pickers = await rows(page).locator('[role=gridcell]:nth-child(6)').allTextContents();
    expect(pickers.length).toBeGreaterThan(0);
    expect(new Set(pickers)).toEqual(new Set(['Ravi']));

    await statusChip(page, 'Picking').click();
    await rows(page).first().click();
    const drawer = page.getByTestId('order-drawer');
    await expect(drawer.getByRole('button', { name: 'Mark packed' })).toBeEnabled();
    await expect(drawer.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  });
});

test.describe('orders table', () => {
  test('shows 10,000 orders while keeping only a screenful in the DOM', async ({ page }) => {
    await login(page, 'manager');
    await expect(page.getByTestId('order-count')).toContainText(/10,\d{3} orders/);
    expect(await rows(page).count()).toBeLessThan(60);

    // Scroll past the first page (200 rows): the next page loads on its own.
    const scroller = page.getByTestId('orders-scroll');
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.locator('[data-testid=order-row][aria-rowindex="202"]')).toBeAttached();
    await scroller.evaluate((el) => el.scrollTo(0, 44 * 320));
    await expect(page.locator('[data-testid=order-row][aria-rowindex="322"]')).toBeVisible();
    expect(await rows(page).count()).toBeLessThan(60);
  });

  test('search and status filters are kept in the URL', async ({ page }) => {
    await login(page, 'manager');
    const firstId = (await rows(page).first().getAttribute('data-order-id'))!;
    await page.getByLabel('Search orders').fill(firstId);
    await expect(page.getByTestId('order-count')).toHaveText('1 order');
    await expect(page).toHaveURL(new RegExp(`q=${firstId}`));

    await page.reload();
    await expect(page.getByLabel('Search orders')).toHaveValue(firstId);
    await expect(page.getByTestId('order-count')).toHaveText('1 order');

    await page.getByLabel('Search orders').fill('zzzz-no-such-order');
    await expect(page.getByText('No orders match this filter.')).toBeVisible();
  });
});

test.describe('live updates', () => {
  test('a change made by the manager appears on the viewer screen without a refresh', async ({ browser }) => {
    const managerPage = await (await browser.newContext()).newPage();
    const viewerPage = await (await browser.newContext()).newPage();
    await login(managerPage, 'manager');
    await login(viewerPage, 'viewer');

    // Manager: open the newest "New" order, assign a picker, start picking.
    await statusChip(managerPage, 'New').click();
    const row = rows(managerPage).first();
    const id = (await row.getAttribute('data-order-id'))!;
    const viewerRow = viewerPage.locator(`[data-order-id="${id}"]`);
    await expect(viewerRow).toContainText('New');

    await row.click();
    const drawer = managerPage.getByTestId('order-drawer');
    await drawer.getByLabel('Picker').selectOption({ label: 'Sana' });
    await expect(viewerRow).toContainText('Sana');

    await drawer.getByRole('button', { name: 'Start picking' }).click();
    await expect(drawer.getByText('Picking', { exact: true })).toBeVisible();
    // The order left the manager's "New" filter...
    await expect(managerPage.locator(`[data-testid=order-row][data-order-id="${id}"]`)).toHaveCount(0);
    // ...and the viewer saw the new status arrive over the WebSocket.
    await expect(viewerRow).toContainText('Picking');
  });

  test('shows an offline banner, then recovers', async ({ page, context }) => {
    await login(page, 'manager');
    await context.setOffline(true);
    await expect(page.getByText('You are offline.')).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId('connection')).toHaveText('Live');
    await expect(page.getByText('You are offline.')).toBeHidden();
  });
});

test.describe('create order', () => {
  test('validates each step, then creates the order', async ({ page }) => {
    await login(page, 'manager');
    await page.getByRole('link', { name: '+ New order' }).click();

    // Step 1: cannot continue with empty or invalid fields.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Enter the customer name')).toBeVisible();
    await page.getByLabel('Name').fill('Asha Rao');
    await page.getByLabel('Mobile number').fill('12345');
    await page.getByLabel('Delivery address').fill('12, 4th Cross, Indiranagar, Bengaluru');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Enter a 10-digit mobile number')).toBeVisible();
    await page.getByLabel('Mobile number').fill('9876543210');
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2: needs at least one item; adding the same item twice merges the lines.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Add at least one item')).toBeVisible();
    await page.getByLabel('Search items to add').fill('Paneer (Regular)');
    const add = page.getByRole('button', { name: 'Add', exact: true });
    await add.click();
    await add.click();
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(page.getByTestId('cart-line').getByLabel('Quantity')).toHaveText('2');
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 3: review and submit.
    await expect(page.getByText('Paneer (Regular)')).toBeVisible();
    await page.getByRole('button', { name: 'Create order' }).click();

    const drawer = page.getByTestId('order-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Asha Rao')).toBeVisible();
    await expect(drawer.getByText('New', { exact: true })).toBeVisible();
    await expect(page.getByText(/ORD-\d+ created/)).toBeVisible();
  });
});

test.describe('inventory', () => {
  test('manager adjusts stock; going below zero is blocked', async ({ page }) => {
    await login(page, 'manager', '/inventory');
    await page.getByLabel('Search inventory').fill('SKU-0001');
    const row = page.getByTestId('inventory-row');
    await expect(row).toHaveCount(1);
    const before = Number(await row.getByTestId('stock').textContent());

    await row.getByRole('spinbutton').fill('5');
    await row.getByRole('button', { name: 'Apply' }).click();
    await expect(row.getByTestId('stock')).toHaveText(String(before + 5));

    await row.getByRole('spinbutton').fill(String(-(before + 6)));
    await expect(row.getByText(/Only \d+ in stock/)).toBeVisible();
    await expect(row.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});

import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth, RequirePermission } from './components/guards';
import { LoginPage } from './pages/LoginPage';
import { MessagePage } from './pages/MessagePage';

// Each page is its own chunk, downloaded only when first visited (code-splitting).
const OrdersPage = lazy(() => import('./pages/OrdersPage'));
const OrderDrawer = lazy(() => import('./components/OrderDrawer'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const NewOrderPage = lazy(() => import('./pages/NewOrderPage'));

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/orders" replace />} />
        <Route path="orders" element={<OrdersPage />}>
          <Route path=":orderId" element={<OrderDrawer />} />
        </Route>
        <Route
          path="orders/new"
          element={
            <RequirePermission permission="orders:create">
              <NewOrderPage />
            </RequirePermission>
          }
        />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="*" element={<MessagePage title="Page not found" body="That address does not exist." />} />
      </Route>
    </Routes>
  );
}

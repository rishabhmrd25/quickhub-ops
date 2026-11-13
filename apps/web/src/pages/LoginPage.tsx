import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { loginSchema, type LoginInput, type LoginResponse } from '@quickhub/shared';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../stores/session';

const DEMO_ACCOUNTS = [
  { role: 'Manager', email: 'manager@quickhub.dev', hint: 'Full access' },
  { role: 'Picker', email: 'picker@quickhub.dev', hint: 'Own orders only' },
  { role: 'Viewer', email: 'viewer@quickhub.dev', hint: 'Read-only' },
];

export function LoginPage() {
  const token = useSession((s) => s.token);
  const setSession = useSession((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/orders';

  const { register, handleSubmit, setValue, formState } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const login = useMutation({
    mutationFn: (input: LoginInput) => api<LoginResponse>('/api/auth/login', { method: 'POST', body: input }),
    onSuccess: ({ token, user }) => {
      setSession(token, user);
      navigate(from, { replace: true });
    },
  });

  if (token) return <Navigate to={from} replace />;

  return (
    <div className="login">
      <form className="card login-card" onSubmit={handleSubmit((v) => login.mutate(v))} noValidate>
        <h1>
          QuickHub <span>Ops</span>
        </h1>
        <p className="muted">Dark-store operations dashboard (demo data)</p>

        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" aria-invalid={!!formState.errors.email} {...register('email')} />
          {formState.errors.email && <em role="alert">{formState.errors.email.message}</em>}
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" aria-invalid={!!formState.errors.password} {...register('password')} />
          {formState.errors.password && <em role="alert">{formState.errors.password.message}</em>}
        </label>

        {login.isError && (
          <p className="form-error" role="alert">
            {errorMessage(login.error)}
          </p>
        )}
        <button className="btn primary block" type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="demo">
          <p className="muted">Demo accounts (click to fill):</p>
          <div className="demo-row">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.role}
                type="button"
                className="btn"
                onClick={() => {
                  setValue('email', a.email, { shouldValidate: true });
                  setValue('password', 'demo1234', { shouldValidate: true });
                }}
              >
                <strong>{a.role}</strong>
                <small>{a.hint}</small>
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
}

import { Component, type ReactNode } from 'react';
import { reportError } from '../lib/monitoring';

interface Props {
  children: ReactNode;
  /** Change this (e.g. the current URL) to clear the error when the user navigates. */
  resetKey?: string;
}

/** Catches render crashes so one broken component doesn't blank the whole app. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { componentStack: info.componentStack });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="message-page" role="alert">
        <h1>Something broke on this screen</h1>
        <p>The error has been logged. You can try again.</p>
        <button className="btn primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

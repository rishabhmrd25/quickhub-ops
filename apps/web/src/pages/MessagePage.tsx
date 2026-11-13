import { Link } from 'react-router-dom';

export function MessagePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="message-page">
      <h1>{title}</h1>
      <p>{body}</p>
      <Link className="btn primary" to="/orders">
        Back to orders
      </Link>
    </div>
  );
}

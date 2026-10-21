import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'dark-exchange.com — A clearer view of crypto',
  description: 'Explore a thoughtfully designed cryptocurrency exchange sandbox. Public crypto market prices, practice portfolios, and transparent test balances. No real funds.',
  icons: { icon: '/favicon.svg', apple: '/favicon.svg' },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dragnet',
  description: 'AI-powered PR Code Review',
  icons: {
    icon: '/favicon.svg',
    apple: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}

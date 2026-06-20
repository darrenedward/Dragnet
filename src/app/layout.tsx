import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pull Request Reviewer',
  description: 'AI-powered PR Code Review',
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

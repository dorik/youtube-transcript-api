import Link from 'next/link';
import { SiteNav } from '@/components/marketing/site-nav';
import { SiteFooter } from '@/components/marketing/site-footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Plan {
  id: string;
  name: string;
  price: number;
  credits: number;
  description: string;
  features: string[];
  highlighted?: boolean;
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    credits: 100,
    description: 'For trying it out',
    features: [
      '100 credits / month',
      'All output formats',
      '100+ languages',
      'No credit card required',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    price: 9,
    credits: 2_500,
    description: 'For hobbyists and indie devs',
    features: [
      '2,500 credits / month',
      'Whisper fallback included',
      'Email support',
      'Cancel anytime',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 29,
    credits: 12_000,
    description: 'For growing applications',
    features: [
      '12,000 credits / month',
      'Whisper fallback included',
      'Priority email support',
      '99.5% uptime SLA',
    ],
    highlighted: true,
  },
  {
    id: 'business',
    name: 'Business',
    price: 79,
    credits: 40_000,
    description: 'For production workloads',
    features: [
      '40,000 credits / month',
      'Whisper fallback included',
      'Priority support',
      'Volume discounts available',
    ],
  },
];

const FAQ = [
  {
    q: 'What counts as one credit?',
    a: 'One transcript fetched via native YouTube captions (any video length) costs 1 credit. Whisper transcription costs 1 credit per minute of audio (rounded up).',
  },
  {
    q: 'Do unused credits roll over?',
    a: 'No — credits reset at the start of each monthly billing cycle. Pick the plan that matches your typical usage.',
  },
  {
    q: 'Is there an SLA?',
    a: 'Pro and Business plans include a 99.5% uptime SLA. Status and incident history are publicly available.',
  },
  {
    q: 'Can I switch plans?',
    a: 'Yes, anytime from the dashboard. Upgrades reset your credit balance to the new plan immediately.',
  },
];

export default function PricingPage() {
  return (
    <>
      <SiteNav />
      <main className="container mx-auto px-4 max-w-6xl">
        <section className="py-16 text-center">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Simple, transparent pricing
          </h1>
          <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
            Pay for what you use. Whisper transcription is included on every plan — no premium-tier games.
          </p>
        </section>

        {/* Plans */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pb-16">
          {PLANS.map((plan) => (
            <Card
              key={plan.id}
              className={cn(
                'relative flex flex-col',
                plan.highlighted && 'border-foreground shadow-lg ring-2 ring-foreground/10',
              )}
            >
              {plan.highlighted && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">
                  Most popular
                </Badge>
              )}
              <CardHeader>
                <CardTitle className="text-xl">{plan.name}</CardTitle>
                <p className="text-sm text-muted-foreground">{plan.description}</p>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col">
                <div className="mb-6">
                  <span className="text-4xl font-bold tracking-tight">${plan.price}</span>
                  <span className="text-muted-foreground"> / month</span>
                </div>
                <p className="text-sm font-medium mb-3">
                  {plan.credits.toLocaleString()} credits / month
                </p>
                <ul className="space-y-2 text-sm flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="text-foreground/60 mt-0.5">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  className="mt-6 w-full"
                  variant={plan.highlighted ? 'default' : 'outline'}
                >
                  <Link href={`/signup${plan.id === 'free' ? '' : `?plan=${plan.id}`}`}>
                    {plan.id === 'free' ? 'Sign up free' : `Get ${plan.name}`}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* FAQ */}
        <section className="py-16 max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-10">Frequently asked questions</h2>
          <div className="space-y-6">
            {FAQ.map((item) => (
              <div key={item.q}>
                <h3 className="font-semibold">{item.q}</h3>
                <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
  	extend: {
  		fontFamily: {
  			sans: ['var(--font-sans)'],
  			mono: ['var(--font-mono)'],
  		},
  		borderRadius: {
  			sm: 'var(--radius-sm)',
  			DEFAULT: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			lg: 'var(--radius-lg)',
  			xl: 'var(--radius-xl)',
  		},
  		boxShadow: {
  			sm: 'var(--shadow-sm)',
  			DEFAULT: 'var(--shadow)',
  			lg: 'var(--shadow-lg)',
  			glow: '0px 20px 40px rgba(159, 167, 255, 0.08)',
  		},
  		backgroundImage: {
  			'primary-gradient': 'linear-gradient(135deg, #9fa7ff, #5764f1)',
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'var(--accent)',
  				foreground: 'hsl(var(--accent-foreground))',
  				hi: 'var(--accent-hi)',
  				bg: 'var(--accent-bg)',
  				'bg-hi': 'var(--accent-bg-hi)',
  				ring: 'var(--accent-ring)',
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: {
  				DEFAULT: 'var(--border)',
  				strong: 'var(--border-strong)',
  				soft: 'var(--border-soft)',
  			},
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			bg: {
  				0: 'var(--bg-0)',
  				1: 'var(--bg-1)',
  				2: 'var(--bg-2)',
  				3: 'var(--bg-3)',
  				4: 'var(--bg-4)',
  				hover: 'var(--bg-hover)',
  			},
  			fg: {
  				0: 'var(--fg-0)',
  				1: 'var(--fg-1)',
  				2: 'var(--fg-2)',
  				3: 'var(--fg-3)',
  				4: 'var(--fg-4)',
  			},
  			t: {
  				violet: 'var(--t-violet)',
  				blue: 'var(--t-blue)',
  				cyan: 'var(--t-cyan)',
  				green: 'var(--t-green)',
  				amber: 'var(--t-amber)',
  				rose: 'var(--t-rose)',
  				pink: 'var(--t-pink)',
  			},
  			surface: {
  				lowest: 'hsl(var(--surface-lowest))',
  				low: 'hsl(var(--surface-low))',
  				DEFAULT: 'hsl(var(--surface))',
  				high: 'hsl(var(--surface-high))',
  				highest: 'hsl(var(--surface-highest))',
  			},
  			ghost: 'rgba(72, 72, 72, 0.15)',
  			tooltip: {
  				DEFAULT: 'hsl(var(--tooltip))',
  				foreground: 'hsl(var(--tooltip-foreground))'
  			},
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // ==========================================
        // 🎨 Refined Minimal 设计系统
        // ==========================================

        // 主色调 - 温暖的中性色
        neutral: {
          50: '#fafaf9',
          100: '#f5f5f4',
          150: '#eeeeec',
          200: '#e7e5e4',
          300: '#d6d3d1',
          400: '#a8a29e',
          500: '#78716c',
          600: '#57534e',
          700: '#44403c',
          800: '#292524',
          850: '#1f1e1d',
          900: '#1c1917',
          950: '#0c0a09',
        },

        // 强调色 - 克制的靛蓝
        accent: {
          50: '#f0f4ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },

        // 成功色 - 柔和的绿
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          500: '#22c55e',
          600: '#16a34a',
        },

        // 警告色 - 琥珀
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          500: '#f59e0b',
          600: '#d97706',
        },

        // 危险色 - 柔和的红
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',
          600: '#dc2626',
        },

        // 语义化颜色别名（向后兼容）
        primary: {
          50: '#f0f4ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        background: '#fafaf9',
        surface: '#ffffff',
        'on-primary': '#ffffff',
        'on-background': '#1c1917',
        'on-surface': '#1c1917',
      },

      fontFamily: {
        // Geist 字体 - 现代、清晰、科技感
        sans: [
          'Geist',
          'SF Pro Display',
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'Geist Mono',
          'SF Mono',
          'ui-monospace',
          'Menlo',
          'Monaco',
          'monospace',
        ],
      },

      fontSize: {
        'xs': ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        'sm': ['0.8125rem', { lineHeight: '1.25rem', letterSpacing: '0.005em' }],
        'base': ['0.875rem', { lineHeight: '1.5rem', letterSpacing: '0' }],
        'lg': ['1rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        'xl': ['1.125rem', { lineHeight: '1.75rem', letterSpacing: '-0.015em' }],
        '2xl': ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.02em' }],
        '3xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.025em' }],
      },

      borderRadius: {
        'sm': '0.25rem',
        'md': '0.375rem',
        'lg': '0.5rem',
        'xl': '0.75rem',
        '2xl': '1rem',
        '3xl': '1.5rem',
      },

      boxShadow: {
        // 精致的阴影系统
        'subtle': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
        'soft': '0 1px 3px 0 rgb(0 0 0 / 0.05), 0 1px 2px -1px rgb(0 0 0 / 0.05)',
        'medium': '0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        'elevated': '0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.05)',
        'floating': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.08)',
        'glow': '0 0 20px -5px rgb(99 102 241 / 0.4)',
        'glow-sm': '0 0 10px -3px rgb(99 102 241 / 0.3)',
        // 深色模式阴影
        'dark-subtle': '0 1px 2px 0 rgb(0 0 0 / 0.2)',
        'dark-soft': '0 1px 3px 0 rgb(0 0 0 / 0.3), 0 1px 2px -1px rgb(0 0 0 / 0.2)',
        'dark-medium': '0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3)',
        'dark-elevated': '0 10px 15px -3px rgb(0 0 0 / 0.5), 0 4px 6px -4px rgb(0 0 0 / 0.3)',
        // 内阴影
        'inner-soft': 'inset 0 2px 4px 0 rgb(0 0 0 / 0.04)',
      },

      backdropBlur: {
        'xs': '2px',
      },

      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'fade-in-up': 'fadeInUp 0.3s ease-out',
        'fade-in-down': 'fadeInDown 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'slide-in-left': 'slideInLeft 0.3s ease-out',
        'shimmer': 'shimmer 2s infinite linear',
        'pulse-soft': 'pulseSoft 2s infinite ease-in-out',
        'bounce-subtle': 'bounceSubtle 0.4s ease-out',
      },

      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeInDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        bounceSubtle: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.02)' },
          '100%': { transform: 'scale(1)' },
        },
      },

      transitionDuration: {
        '150': '150ms',
        '250': '250ms',
        '350': '350ms',
      },

      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'bounce': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'out-expo': 'cubic-bezier(0.19, 1, 0.22, 1)',
      },
    },
  },
  plugins: [],
};

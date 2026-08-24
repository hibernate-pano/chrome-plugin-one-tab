/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // ==========================================
        // 🎨 TapStack 生产力工具设计系统
        // Micro-interactions + Teal/Orange 配色
        // ==========================================

        // 主色调 - 专业的青色（Teal）
        primary: {
          50: '#F0FDFA',   // 极淡青色背景
          100: '#CCFBF1',  // 淡青色
          200: '#99F6E4',
          300: '#5EEAD4',
          400: '#2DD4BF',
          500: '#14B8A6',  // 次要青色
          600: '#0D9488',  // 主要青色 - 品牌色
          700: '#0F766E',  // 深青色
          800: '#115E59',
          900: '#134E4A',  // 深绿青 - 文字色
          950: '#042F2E',
        },

        // CTA 行动色 - 活力橙色
        accent: {
          50: '#FFF7ED',
          100: '#FFEDD5',
          200: '#FED7AA',
          300: '#FDBA74',
          400: '#FB923C',
          500: '#F97316',  // 橙色 CTA - 高转化
          600: '#EA580C',
          700: '#C2410C',
          800: '#9A3412',
          900: '#7C2D12',
        },

        // 中性色 - 温暖灰
        neutral: {
          50: '#FAFAF9',
          100: '#F5F5F4',
          200: '#E7E5E4',
          300: '#D6D3D1',
          400: '#A8A29E',
          500: '#78716C',
          600: '#57534E',
          700: '#44403C',
          800: '#292524',
          900: '#1C1917',
          950: '#0C0A09',
        },

        // 成功色 - 清新绿
        success: {
          50: '#F0FDF4',
          100: '#DCFCE7',
          200: '#BBF7D0',
          500: '#22C55E',
          600: '#16A34A',
          700: '#15803D',
        },

        // 警告色 - 琥珀黄
        warning: {
          50: '#FFFBEB',
          100: '#FEF3C7',
          200: '#FDE68A',
          500: '#F59E0B',
          600: '#D97706',
          700: '#B45309',
        },

        // 危险色 - 温和红
        danger: {
          50: '#FEF2F2',
          100: '#FEE2E2',
          200: '#FECACA',
          500: '#EF4444',
          600: '#DC2626',
          700: '#B91C1C',
        },

        // 语义化别名
        background: '#F0FDFA',
        surface: '#FFFFFF',
        'on-primary': '#FFFFFF',
        'on-background': '#134E4A',
        'on-surface': '#1C1917',
      },

      fontFamily: {
        // Plus Jakarta Sans - 友好、现代、专业
        sans: [
          'Plus Jakarta Sans',
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
        // 微交互式阴影系统 - 轻盈、快速响应
        'subtle': '0 1px 2px 0 rgb(13 148 136 / 0.04)',
        'soft': '0 1px 3px 0 rgb(13 148 136 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'medium': '0 4px 6px -1px rgb(13 148 136 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        'elevated': '0 10px 15px -3px rgb(13 148 136 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.05)',
        'floating': '0 20px 25px -5px rgb(13 148 136 / 0.12), 0 8px 10px -6px rgb(0 0 0 / 0.08)',
        'glow': '0 0 20px -5px rgb(13 148 136 / 0.3)',
        'glow-sm': '0 0 10px -3px rgb(13 148 136 / 0.2)',
        'hover': '0 4px 12px -2px rgb(13 148 136 / 0.15), 0 2px 6px -1px rgb(0 0 0 / 0.08)',
        'active': '0 2px 4px -1px rgb(13 148 136 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        // 深色模式阴影
        'dark-subtle': '0 1px 2px 0 rgb(0 0 0 / 0.2)',
        'dark-soft': '0 1px 3px 0 rgb(0 0 0 / 0.3), 0 1px 2px -1px rgb(0 0 0 / 0.2)',
        'dark-medium': '0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3)',
        'dark-elevated': '0 10px 15px -3px rgb(0 0 0 / 0.5), 0 4px 6px -4px rgb(0 0 0 / 0.3)',
        'dark-hover': '0 4px 12px -2px rgb(0 0 0 / 0.4), 0 2px 6px -1px rgb(0 0 0 / 0.3)',
        // 内阴影
        'inner-soft': 'inset 0 2px 4px 0 rgb(0 0 0 / 0.04)',
        'inner-glow': 'inset 0 0 0 1px rgb(13 148 136 / 0.1)',
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

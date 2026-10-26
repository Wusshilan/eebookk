import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

const base = (p: P) => ({
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p
})

/** 首页：四瓣花结（沿用设计稿） */
export const IconHome = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="7.2" r="3.9" />
    <circle cx="12" cy="16.8" r="3.9" />
    <circle cx="7.2" cy="12" r="3.9" />
    <circle cx="16.8" cy="12" r="3.9" />
  </svg>
)

export const IconGrid = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </svg>
)

export const IconClock = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8Zm.9 4.6a.9.9 0 1 0-1.8 0v5.1c0 .3.13.55.34.72l3.1 2.6a.9.9 0 0 0 1.13-1.4l-2.77-2.33V7.2Z"
    />
  </svg>
)

export const IconHash = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.4 4.5 7.9 19.5M16.1 4.5 14.6 19.5M4.6 9.2h15.2M3.9 14.8h15.2" />
  </svg>
)

export const IconUser = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="12" cy="8.2" r="3.9" />
    <path d="M4.6 20.2c.55-3.7 3.7-6.1 7.4-6.1s6.85 2.4 7.4 6.1c.06.42-.28.78-.7.78H5.3a.7.7 0 0 1-.7-.78Z" />
  </svg>
)

export const IconBookmark = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M6.4 3.6h11.2c.66 0 1.2.54 1.2 1.2v15.5c0 .55-.64.85-1.06.5L12 16.2l-5.74 4.6c-.42.35-1.06.05-1.06-.5V4.8c0-.66.54-1.2 1.2-1.2Z" />
  </svg>
)

export const IconSort = (p: P) => (
  <svg {...base(p)} width={18} height={18}>
    <path d="M7 4.5v15M7 4.5 4 7.8M7 4.5l3 3.3M17 19.5v-15M17 19.5l-3-3.3M17 19.5l3-3.3" />
  </svg>
)

export const IconPlus = (p: P) => (
  <svg {...base(p)} width={20} height={20}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </svg>
)

export const IconMore = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none" width={18} height={18}>
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
)

export const IconBack = (p: P) => (
  <svg {...base(p)} width={26} height={26}>
    <path d="M15.5 5 8 12l7.5 7" />
  </svg>
)

export const IconSearch = (p: P) => (
  <svg {...base(p)} width={20} height={20}>
    <circle cx="11" cy="11" r="6.4" />
    <path d="m16 16 4 4" />
  </svg>
)

export const IconMail = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2.4" />
    <path d="m3.8 6.6 8.2 6.2 8.2-6.2" />
  </svg>
)

export const IconPalette = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.2a8.8 8.8 0 0 0 0 17.6c1.2 0 1.9-.8 1.9-1.8 0-.6-.3-1.1-.6-1.5-.3-.4-.6-.9-.6-1.4 0-1 .8-1.8 1.8-1.8h1.6a4.7 4.7 0 0 0 4.7-4.7c0-3.6-3.9-6.4-8.8-6.4Z" />
    <circle cx="7.6" cy="11.4" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10.4" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.2" cy="7.9" r="1.1" fill="currentColor" stroke="none" />
  </svg>
)

export const IconCloudOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M6.9 18.4h9.9a4 4 0 0 0 1.2-7.8A5.6 5.6 0 0 0 8.3 8.9" />
    <path d="M6.6 10.5a3.95 3.95 0 0 0 .3 7.9" />
    <path d="m3.6 3.6 16.8 16.8" />
  </svg>
)

export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.6v11M12 14.6 7.6 10.2M12 14.6l4.4-4.4" />
    <path d="M4.4 17.2v1.6a1.6 1.6 0 0 0 1.6 1.6h12a1.6 1.6 0 0 0 1.6-1.6v-1.6" />
  </svg>
)

export const IconGear = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 14.6a1.5 1.5 0 0 0 .3 1.65l.06.06a1.85 1.85 0 1 1-2.6 2.6l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.85 1.85 0 1 1-3.7 0v-.1a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06a1.85 1.85 0 1 1-2.6-2.6l.06-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H4a1.85 1.85 0 1 1 0-3.7h.1a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.06-.06a1.85 1.85 0 1 1 2.6-2.6l.06.06a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V4a1.85 1.85 0 1 1 3.7 0v.1a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.06a1.85 1.85 0 1 1 2.6 2.6l-.06.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9H20a1.85 1.85 0 1 1 0 3.7h-.1a1.5 1.5 0 0 0-1.37.9Z" />
  </svg>
)

export const IconChevron = (p: P) => (
  <svg {...base(p)} width={18} height={18}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </svg>
)

export const IconMinimize = (p: P) => (
  <svg {...base(p)} width={18} height={18}>
    <path d="M5 12h14" />
  </svg>
)

export const IconMaximize = (p: P) => (
  <svg {...base(p)} width={18} height={18}>
    <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
  </svg>
)

export const IconClose = (p: P) => (
  <svg {...base(p)} width={18} height={18}>
    <path d="m5.5 5.5 13 13M18.5 5.5l-13 13" />
  </svg>
)

/** 整理台：滑块 */
export const IconSliders = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.6 7.2h9.2M17.8 7.2h1.6M4.6 16.8h1.6M10 16.8h9.4" />
    <circle cx="15.4" cy="7.2" r="2.4" />
    <circle cx="8.2" cy="16.8" r="2.4" />
  </svg>
)

/** 转换：双向箭头 */
export const IconConvert = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.6 8.4h13.2l-3.2-3.2M19.4 15.6H6.2l3.2 3.2" />
  </svg>
)

/** 设备 */
export const IconDevice = (p: P) => (
  <svg {...base(p)}>
    <rect x="5.4" y="2.8" width="13.2" height="18.4" rx="2.2" />
    <path d="M10.6 18.4h2.8" />
  </svg>
)

/** 表格视图 */
export const IconRows = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6.4h16M4 12h16M4 17.6h16" />
  </svg>
)

/** 网格视图 */
export const IconTiles = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.6" y="3.6" width="7.4" height="7.4" rx="1.6" />
    <rect x="13" y="3.6" width="7.4" height="7.4" rx="1.6" />
    <rect x="3.6" y="13" width="7.4" height="7.4" rx="1.6" />
    <rect x="13" y="13" width="7.4" height="7.4" rx="1.6" />
  </svg>
)

export const IconCheck = (p: P) => (
  <svg {...base(p)} width={16} height={16}>
    <path d="m4.5 12.5 4.6 4.6L19.5 6.8" />
  </svg>
)

export const IconPlay = (p: P) => (
  <svg {...base(p)} width={16} height={16} fill="currentColor" stroke="none">
    <path d="M7.5 4.6v14.8l11.4-7.4z" />
  </svg>
)

export const IconStop = (p: P) => (
  <svg {...base(p)} width={16} height={16} fill="currentColor" stroke="none">
    <rect x="5.4" y="5.4" width="13.2" height="13.2" rx="2" />
  </svg>
)

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20.2 3.8v4.6h-4.6" />
  </svg>
)

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.6 6.6h14.8M9.4 6.6V4.4h5.2v2.2M6.4 6.6l.9 13.2h9.4l.9-13.2" />
  </svg>
)

export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.4 6.6a1.8 1.8 0 0 1 1.8-1.8h4l2 2.4h6a1.8 1.8 0 0 1 1.8 1.8v9.6a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8z" />
  </svg>
)

export const IconBook = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 4.6h6.2a2.4 2.4 0 0 1 2.4 2.4v12.4a1.8 1.8 0 0 0-1.8-1.8H4z" />
    <path d="M20 4.6h-6.2a2.4 2.4 0 0 0-2.4 2.4v12.4a1.8 1.8 0 0 1 1.8-1.8H20z" />
  </svg>
)


export const IconTasks = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 7h9M10 12h9M10 17h6" />
    <circle cx="5.4" cy="7" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="5.4" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="5.4" cy="17" r="1.3" fill="currentColor" stroke="none" />
  </svg>
)

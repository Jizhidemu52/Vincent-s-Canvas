import Link from 'next/link';
import { ArrowUpRight, BookOpen, Rocket } from 'lucide-react';
import { appName } from '@/lib/shared';

const previewImages = [
  {
    src: 'https://i.ibb.co/TDFvGWDT/image.png',
    title: '画布编排',
  },
  {
    src: 'https://i.ibb.co/zVwJq3YS/image.png',
    title: '图片生成',
  },
  {
    src: 'https://i.ibb.co/PvY3qhhK/image.png',
    title: '参考图编辑',
  },
  {
    src: 'https://i.ibb.co/7D04LwN/image.png',
    title: '节点工作流',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-16 pt-8 md:px-10 md:pt-14">
      <section className="grid min-h-[520px] items-center gap-10 border-b border-orange-200 pb-12 dark:border-orange-950 lg:grid-cols-[0.88fr_1.12fr]">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-medium text-orange-700 dark:text-orange-300">
            <Rocket className="size-3.5" />
            内部 AI 图片创作工作台
          </div>
          <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-tight text-orange-950 dark:text-orange-50 md:text-6xl [font-family:var(--font-display)]">
            {appName}
            <span className="block text-orange-700 dark:text-orange-300">文档中心</span>
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-8 text-orange-900/75 dark:text-orange-100/75">
            面向公司内部图片创作流程，集中管理画布编排、AI 生成、参考图编辑、提示词沉淀、素材归档和后台审计。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/docs/overview/quick-start"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-orange-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-orange-700"
            >
              <BookOpen className="size-4" />
              快速开始
            </Link>
            <a
              href="http://localhost:3000/"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-orange-300 px-5 py-3 text-sm font-medium text-orange-950 transition hover:border-orange-700 hover:bg-orange-100 dark:border-orange-900 dark:text-orange-100 dark:hover:bg-orange-950"
            >
              打开工作台
              <ArrowUpRight className="size-4" />
            </a>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl lg:w-[108%] lg:max-w-none">
          <img
            src={previewImages[3].src}
            alt="无线画布效果图"
            className="aspect-[16/10] w-full rounded-xl object-cover"
          />
        </div>
      </section>

      <section className="mt-14">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-orange-950 dark:text-orange-50 md:text-3xl">
              功能入口
            </h2>
            <p className="mt-2 text-sm text-orange-900/70 dark:text-orange-100/70">
              按团队使用路径整理的内部说明。
            </p>
          </div>
          <Link
            href="/docs/overview/features"
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-orange-800 transition hover:text-orange-950 dark:text-orange-200 dark:hover:text-white"
          >
            功能介绍
            <ArrowUpRight className="size-4" />
          </Link>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {previewImages.map((item) => (
            <img
              key={item.src}
              src={item.src}
              alt={`${item.title}效果图`}
              loading="lazy"
              decoding="async"
              className="aspect-[16/10] w-full rounded-2xl object-cover"
            />
          ))}
        </div>
      </section>
    </main>
  );
}

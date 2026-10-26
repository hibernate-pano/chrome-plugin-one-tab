/**
 * PostgREST 行类型（createClient<Database> 的实参）。
 *
 * 【为什么需要这个文件】supabase-js 的 createClient 声明为
 * `<Database = any, ...>`（node_modules/@supabase/supabase-js/dist/index.d.mts:833）。
 * 不传类型参数时 Database 落到 any，SupabaseClient 的
 * `Schema extends ... = Omit<Database,'__InternalSupabase'>['public'] extends GenericSchema ? ... : never`
 * （同文件 :451）把它压成 never，`.update()` / `.upsert()` 因此只接受 never。
 * 传进来一份真实行类型即可让 PostgREST 推断恢复。
 *
 * 【列的来源】全部来自 supabase/migrations/*.sql，逐条标注文件:行。
 *   - profiles / ai_usage_logs / sync_updates / sync_snapshots：迁移里有
 *     CREATE TABLE，全列照抄。
 *   - tab_groups / tabs / user_settings：**仓库里没有它们的 CREATE TABLE**
 *     ——三表都是早期在 Supabase Dashboard 建的（见
 *     20251014063149_enable_realtime_for_tables.sql:2-4 与
 *     20260326034522_harden_tabs_rls_and_sync_settings_columns.sql:2-4 的
 *     「早期直接在 Dashboard 建立，仓库此前缺少对应文件」）。
 *     这三张表只能取交集：迁移里 ALTER TABLE 增补过的列 + 代码实际读写的列。
 *     未在下面声明的列一律不存在于类型里，选错列名会是编译错误而非运行时
 *     PostgREST 42703 —— 这比声称「全列完备」诚实。
 *
 * 【范围】只包含 src/ 真正查询的三张表（tab_groups / tabs / user_settings）。
 * profiles、ai_usage_logs、sync_updates、sync_snapshots 代码里零引用
 * （.from() 全仓只出现 tab_groups / user_settings / tabs 三种），故不声明：
 * 声明了反而是未经迁移证实的推测。纯类型、无运行时影响。
 */

/** Row / Insert / Update 三态里，Insert 与 Update 允许为 null 的列。 */
type Nullable<T> = T | null;

/**
 * tab_groups.tabs_data 的 JSONB 元素类型 = unknown，不是 Record。
 *
 * 写侧放 TabData[]（src/types/tab.ts:39 的 interface，没有索引签名），
 * 读侧全仓都当不透明载荷：download.ts:102 收进 unknown 后交 normalizeTabsData
 * 判形状、upload.ts:686 加密后回写成密文字符串。没有任何一处按元素字段取属性，
 * 标成 Record<string, unknown> 只会平白拒掉 TabData[]。
 * 保留 unknown[] 而非 any[]：让「这里没被类型检查过」保持可见。
 */
type TabsDataElement = unknown;

export type Database = {
  public: {
    Tables: {
      tab_groups: {
        Row: {
          id: string;
          name: string;
          user_id: string;
          created_at: string;
          updated_at: string;
          /** 20260826061933_add_tab_group_version_guard.sql:19 — integer NOT NULL DEFAULT 1 */
          version: number;
          /** 20260825130248_add_is_deleted_tombstone.sql:18 — boolean NOT NULL DEFAULT false */
          is_deleted: boolean;
          /** 20260926090000_tombstone_expiry.sql:21 — timestamptz NULL */
          deleted_at: Nullable<string>;
          /** 20260909_add_op_stamp_columns.sql:20 — text，可空 */
          last_op_device: Nullable<string>;
          /** 20261025_add_imported_at_to_tab_groups.sql — timestamptz NULL
           *  （「保存时间未知」的标记；列不存在时上传侧整列省略，见 upload.ts） */
          imported_at: Nullable<string>;
          /** 20260909_add_op_stamp_columns.sql:21 — bigint，可空 */
          last_op_seq: Nullable<number>;
          /** 以下三列无迁移出处，类型取自 src/types/tab.ts:58-67 SupabaseTabGroup
           *  （该接口是上传行的既有权威形状，见 upload.ts:645）。 */
          is_locked: boolean;
          device_id: string;
          last_sync: string;
          /** 加密后的标签数组；upload.ts:447 的 .update({ tabs_data }) 与
           *  download.ts:186 的 select('*') 都按「可空的对象数组」使用。 */
          tabs_data: Nullable<TabsDataElement[]>;
        };
        Insert: {
          id: string;
          name: string;
          user_id: string;
          created_at: string;
          updated_at: string;
          version?: number;
          is_deleted?: boolean;
          deleted_at?: Nullable<string>;
          last_op_device?: Nullable<string>;
          last_op_seq?: Nullable<number>;
          imported_at?: Nullable<string>;
          is_locked?: boolean;
          device_id?: string;
          last_sync?: string;
          tabs_data?: Nullable<TabsDataElement[]>;
        };
        Update: {
          user_id?: string;
          name?: string;
          updated_at?: string;
          version?: number;
          is_deleted?: boolean;
          deleted_at?: Nullable<string>;
          last_op_device?: Nullable<string>;
          last_op_seq?: Nullable<number>;
          imported_at?: Nullable<string>;
          is_locked?: boolean;
          device_id?: string;
          last_sync?: string;
          tabs_data?: Nullable<TabsDataElement[]>;
        };
        Relationships: [];
      };

      /** 老版本写入方（upload.ts:421 / download.ts:419 的 tabs 表回填路径）。
       *  代码只 select('*') 后逐字段 String() 化读 id/url/title/favicon/
       *  created_at/last_accessed/group_id/pinned/isDeleted，
       *  故按这些列建模；无迁移给出该表的建表语句。 */
      tabs: {
        Row: {
          id: string;
          group_id: string;
          url: string;
          title: string;
          favicon: Nullable<string>;
          created_at: string;
          last_accessed: string;
          pinned: Nullable<boolean>;
          is_deleted: Nullable<boolean>;
        };
        Insert: {
          id: string;
          group_id: string;
          url: string;
          title: string;
          favicon?: Nullable<string>;
          created_at: string;
          last_accessed: string;
          pinned?: Nullable<boolean>;
          is_deleted?: Nullable<boolean>;
        };
        Update: {
          group_id?: string;
          url?: string;
          title?: string;
          favicon?: Nullable<string>;
          created_at?: string;
          last_accessed?: string;
          pinned?: Nullable<boolean>;
          is_deleted?: Nullable<boolean>;
        };
        Relationships: [];
      };

      user_settings: {
        Row: {
          user_id: string;
          /** 无迁移出处；upload.ts:1269 每次上行都写。 */
          device_id: Nullable<string>;
          /** 无迁移出处；upload.ts:1270 每次上行都写。 */
          last_sync: Nullable<string>;
          /** 20260326034522_...sql:8-9 — text，NOT NULL DEFAULT 'single'，check in ('single','double') */
          layout_mode: string;
          /** 20260326034522_...sql:10 — boolean NOT NULL DEFAULT false */
          reorder_mode: boolean;
          /** 20260125071141_...sql:7 — text，可空 */
          theme_style: Nullable<string>;
          /** 20260210072717_...sql:7 — boolean NOT NULL DEFAULT false */
          collect_pinned_tabs: boolean;
          /** 20261011190000_...sql:8 — integer NOT NULL DEFAULT 10 */
          sync_interval_minutes: number;
          /** 20261011190000_...sql:3 注明「sync_enabled 列已存在（历史版本建的）」，
           *  仓库无建表语句可查，类型取自 download.ts:546 fieldMapping 与
           *  upload.ts:1242 allowedFields 的 boolean 语义。 */
          sync_enabled: Nullable<boolean>;
          /** 以下六列同样无迁移出处，类型按 upload.ts:1232-1246 的
           *  allowedFields 与 download.ts:539-557 的 fieldMapping 取
           *  UserSettings 侧的标量语义；JSONB 列故放宽为 unknown。 */
          group_name_template: Nullable<unknown>;
          show_favicons: Nullable<unknown>;
          show_tab_count: Nullable<unknown>;
          confirm_before_delete: Nullable<unknown>;
          allow_duplicate_tabs: Nullable<unknown>;
          show_notifications: Nullable<unknown>;
          sync_strategy: Nullable<unknown>;
          delete_strategy: Nullable<unknown>;
          theme_mode: Nullable<unknown>;
          use_double_column_layout: Nullable<unknown>;
        };
        Insert: {
          user_id: string;
          device_id?: Nullable<string>;
          last_sync?: Nullable<string>;
          layout_mode?: string;
          reorder_mode?: boolean;
          theme_style?: Nullable<string>;
          collect_pinned_tabs?: boolean;
          sync_interval_minutes?: number;
          sync_enabled?: Nullable<boolean>;
          group_name_template?: Nullable<unknown>;
          show_favicons?: Nullable<unknown>;
          show_tab_count?: Nullable<unknown>;
          confirm_before_delete?: Nullable<unknown>;
          allow_duplicate_tabs?: Nullable<unknown>;
          show_notifications?: Nullable<unknown>;
          sync_strategy?: Nullable<unknown>;
          delete_strategy?: Nullable<unknown>;
          theme_mode?: Nullable<unknown>;
          use_double_column_layout?: Nullable<unknown>;
        };
        Update: {
          device_id?: Nullable<string>;
          last_sync?: Nullable<string>;
          layout_mode?: string;
          reorder_mode?: boolean;
          theme_style?: Nullable<string>;
          collect_pinned_tabs?: boolean;
          sync_interval_minutes?: number;
          sync_enabled?: Nullable<boolean>;
          group_name_template?: Nullable<unknown>;
          show_favicons?: Nullable<unknown>;
          show_tab_count?: Nullable<unknown>;
          confirm_before_delete?: Nullable<unknown>;
          allow_duplicate_tabs?: Nullable<unknown>;
          show_notifications?: Nullable<unknown>;
          sync_strategy?: Nullable<unknown>;
          delete_strategy?: Nullable<unknown>;
          theme_mode?: Nullable<unknown>;
          use_double_column_layout?: Nullable<unknown>;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

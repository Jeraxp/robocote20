import { randomUUID } from 'crypto';
import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';
import type { AuthContext, UserRole } from '../auth/context.js';

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  documentType: 'cpf' | 'cnpj' | null;
  documentMasked: string | null;
  phoneMasked: string | null;
  managerName: string | null;
  managerEmail: string | null;
  managerPhoneMasked: string | null;
  status: 'active' | 'paused' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  phoneMasked: string | null;
  status: 'active' | 'invited' | 'disabled';
  role: UserRole;
  tenantId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantInput {
  documentType: 'cpf' | 'cnpj';
  document: string;
  brokerName: string;
  brokerPhone: string;
  managerName: string;
  managerEmail: string;
  managerWhatsapp: string;
}

export interface CreateTenantResult {
  tenant: TenantRecord;
  manager: UserRecord;
}

export interface WhatsappInstanceRecord {
  id: string;
  tenantId: string;
  evolutionInstanceName: string;
  ownerPhone: string | null;
  status: string;
  lastConnectionState: string | null;
  lastQrAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminStore {
  listTenants(auth: AuthContext): Promise<TenantRecord[]>;
  listUsers(auth: AuthContext, tenantId?: string): Promise<UserRecord[]>;
  createTenantWithManager(input: CreateTenantInput): Promise<CreateTenantResult>;
  listWhatsappInstances(auth: AuthContext, tenantId?: string): Promise<WhatsappInstanceRecord[]>;
  createWhatsappInstance(input: {
    tenantId: string;
    evolutionInstanceName: string;
    ownerPhone?: string;
  }): Promise<WhatsappInstanceRecord>;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function maskDocument(value: unknown, type?: unknown): string | null {
  const digits = typeof value === 'string' ? digitsOnly(value) : '';
  if (!digits) return null;
  if (type === 'cnpj' && digits.length >= 14) return `${digits.slice(0, 2)}.***.***/****-${digits.slice(-2)}`;
  if (digits.length >= 11) return `***.***.***-${digits.slice(-2)}`;
  return `<documento ${digits.slice(-4)}>`;
}

function maskPhone(value: unknown): string | null {
  const digits = typeof value === 'string' ? digitsOnly(value) : '';
  if (digits.length < 4) return null;
  return `(**) *****-${digits.slice(-4)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52) || `corretora-${Date.now()}`;
}

function userIdFromEmail(email: string): string {
  return `user-${slugify(email.replace('@', '-at-'))}-${randomUUID().slice(0, 8)}`;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date().toISOString();
}

function rowTenant(row: Record<string, unknown>): TenantRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    documentType: typeof row.document_type === 'string' ? row.document_type as TenantRecord['documentType'] : null,
    documentMasked: maskDocument(row.document ?? row.document_digits, row.document_type),
    phoneMasked: maskPhone(row.phone),
    managerName: typeof row.manager_name === 'string' ? row.manager_name : null,
    managerEmail: typeof row.manager_email === 'string' ? row.manager_email : null,
    managerPhoneMasked: maskPhone(row.manager_phone),
    status: String(row.status) as TenantRecord['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    phoneMasked: maskPhone(row.phone),
    status: String(row.status) as UserRecord['status'],
    role: String(row.role) as UserRole,
    tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowWhatsapp(row: Record<string, unknown>): WhatsappInstanceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    evolutionInstanceName: String(row.evolution_instance_name),
    ownerPhone: typeof row.owner_phone === 'string' ? row.owner_phone : null,
    status: String(row.status),
    lastConnectionState: typeof row.last_connection_state === 'string' ? row.last_connection_state : null,
    lastQrAt: row.last_qr_at ? iso(row.last_qr_at) : null,
    connectedAt: row.connected_at ? iso(row.connected_at) : null,
    disconnectedAt: row.disconnected_at ? iso(row.disconnected_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

class InMemoryAdminStore implements AdminStore {
  private readonly tenants: TenantRecord[] = [
    {
      id: process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi',
      slug: process.env.ROBOCOTE_TENANT_SLUG?.trim() || 'rpi',
      name: process.env.ROBOCOTE_TENANT_NAME?.trim() || 'Corretora Piloto RPI',
      documentType: null,
      documentMasked: null,
      phoneMasked: null,
      managerName: 'Gestor da Corretora',
      managerEmail: `gestor@${process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi'}.local`,
      managerPhoneMasked: null,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  private readonly users = new Map<string, UserRecord>();
  private readonly whatsapp = new Map<string, WhatsappInstanceRecord>();

  async listTenants(auth: AuthContext): Promise<TenantRecord[]> {
    if (auth.isSuperadmin) return this.tenants;
    return this.tenants.filter((tenant) => tenant.id === auth.tenantId);
  }

  async listUsers(auth: AuthContext, tenantId?: string): Promise<UserRecord[]> {
    const now = new Date().toISOString();
    const scopedTenants = auth.isSuperadmin && !tenantId
      ? this.tenants
      : this.tenants.filter((tenant) => tenant.id === (tenantId ?? auth.tenantId));
    const users: UserRecord[] = [
      {
        id: 'taskdun-superadmin',
        name: 'Taskdun Superadmin',
        email: 'admin@taskdun.com.br',
        phoneMasked: null,
        status: 'active',
        role: 'superadmin',
        tenantId: null,
        createdAt: now,
        updatedAt: now,
      },
      ...scopedTenants.map((tenant): UserRecord => ({
        id: `${tenant.id}-admin`,
        name: tenant.managerName ?? 'Gestor da Corretora',
        email: tenant.managerEmail ?? `gestor@${tenant.id}.local`,
        phoneMasked: tenant.managerPhoneMasked,
        status: 'active',
        role: 'admin',
        tenantId: tenant.id,
        createdAt: now,
        updatedAt: now,
      })),
    ];
    if (auth.isSuperadmin) return users;
    return users.filter((user) => user.tenantId === auth.tenantId);
  }

  async createTenantWithManager(input: CreateTenantInput): Promise<CreateTenantResult> {
    const now = new Date().toISOString();
    const base = slugify(input.brokerName);
    let slug = base;
    let suffix = 2;
    while (this.tenants.some((tenant) => tenant.slug === slug || tenant.id === slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }

    const tenant: TenantRecord = {
      id: slug,
      slug,
      name: input.brokerName,
      documentType: input.documentType,
      documentMasked: maskDocument(input.document, input.documentType),
      phoneMasked: maskPhone(input.brokerPhone),
      managerName: input.managerName,
      managerEmail: input.managerEmail,
      managerPhoneMasked: maskPhone(input.managerWhatsapp),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const manager: UserRecord = {
      id: userIdFromEmail(input.managerEmail),
      name: input.managerName,
      email: input.managerEmail,
      phoneMasked: maskPhone(input.managerWhatsapp),
      status: 'invited',
      role: 'admin',
      tenantId: tenant.id,
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.push(tenant);
    this.users.set(manager.id, manager);
    return { tenant, manager };
  }

  async listWhatsappInstances(auth: AuthContext, tenantId?: string): Promise<WhatsappInstanceRecord[]> {
    const target = tenantId ?? auth.tenantId;
    return [...this.whatsapp.values()]
      .filter((item) => auth.isSuperadmin || item.tenantId === target)
      .filter((item) => !target || item.tenantId === target);
  }

  async createWhatsappInstance(input: {
    tenantId: string;
    evolutionInstanceName: string;
    ownerPhone?: string;
  }): Promise<WhatsappInstanceRecord> {
    const now = new Date().toISOString();
    const record: WhatsappInstanceRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      evolutionInstanceName: input.evolutionInstanceName,
      ownerPhone: input.ownerPhone || null,
      status: 'created',
      lastConnectionState: null,
      lastQrAt: null,
      connectedAt: null,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.whatsapp.set(record.id, record);
    return record;
  }
}

class PostgresAdminStore implements AdminStore {
  async listTenants(auth: AuthContext): Promise<TenantRecord[]> {
    const pool = getPostgresPool();
    const select = `
      select
        t.*,
        manager.name as manager_name,
        manager.email as manager_email,
        manager.phone as manager_phone
      from tenants t
      left join lateral (
        select u.name, u.email, u.phone
        from tenant_memberships tm
        join users u on u.id = tm.user_id
        where tm.tenant_id = t.id and tm.role = 'admin'
        order by tm.created_at asc
        limit 1
      ) manager on true
    `;
    const result = auth.isSuperadmin
      ? await pool.query(`${select} order by t.name asc`)
      : await pool.query(`${select} where t.id = $1 order by t.name asc`, [auth.tenantId]);
    return result.rows.map(rowTenant);
  }

  async listUsers(auth: AuthContext, tenantId?: string): Promise<UserRecord[]> {
    const pool = getPostgresPool();
    if (auth.isSuperadmin && !tenantId) {
      const result = await pool.query(`
        select u.*, 'superadmin' as role, null::text as tenant_id
        from users u
        join superadmin_users su on su.user_id = u.id
        union all
        select u.*, tm.role, tm.tenant_id
        from users u
        join tenant_memberships tm on tm.user_id = u.id
        order by name asc
      `);
      return result.rows.map(rowUser);
    }

    const target = tenantId ?? auth.tenantId;
    const result = await pool.query(`
      select u.*, tm.role, tm.tenant_id
      from users u
      join tenant_memberships tm on tm.user_id = u.id
      where tm.tenant_id = $1
      order by u.name asc
    `, [target]);
    return result.rows.map(rowUser);
  }

  async listWhatsappInstances(auth: AuthContext, tenantId?: string): Promise<WhatsappInstanceRecord[]> {
    const pool = getPostgresPool();
    const target = tenantId ?? auth.tenantId;
    const result = auth.isSuperadmin && !target
      ? await pool.query('select * from whatsapp_instances order by updated_at desc')
      : await pool.query('select * from whatsapp_instances where tenant_id = $1 order by updated_at desc', [target]);
    return result.rows.map(rowWhatsapp);
  }

  async createWhatsappInstance(input: {
    tenantId: string;
    evolutionInstanceName: string;
    ownerPhone?: string;
  }): Promise<WhatsappInstanceRecord> {
    const pool = getPostgresPool();
    const result = await pool.query(`
      insert into whatsapp_instances (id, tenant_id, evolution_instance_name, owner_phone, status)
      values ($1, $2, $3, $4, 'created')
      returning *
    `, [randomUUID(), input.tenantId, input.evolutionInstanceName, input.ownerPhone || null]);
    return rowWhatsapp(result.rows[0]);
  }

  async createTenantWithManager(input: CreateTenantInput): Promise<CreateTenantResult> {
    const pool = getPostgresPool();
    const client = await pool.connect();
    const baseSlug = slugify(input.brokerName);
    const documentDigits = digitsOnly(input.document);
    const managerPhone = digitsOnly(input.managerWhatsapp);
    const brokerPhone = digitsOnly(input.brokerPhone);

    try {
      await client.query('begin');

      let slug = baseSlug;
      let suffix = 2;
      // Pequeno loop intencional: criação de corretora é operação humana e rara.
      // A constraint UNIQUE continua sendo a garantia real.
      while ((await client.query('select 1 from tenants where id = $1 or slug = $1 limit 1', [slug])).rowCount) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }

      const userId = userIdFromEmail(input.managerEmail);
      const tenantResult = await client.query(`
        insert into tenants (id, slug, name, document_type, document, document_digits, phone, status)
        values ($1, $1, $2, $3, $4, $5, $6, 'active')
        returning *
      `, [slug, input.brokerName, input.documentType, input.document, documentDigits, brokerPhone]);

      const userResult = await client.query(`
        insert into users (id, name, email, phone, status)
        values ($1, $2, $3, $4, 'invited')
        on conflict (email) do update set
          name = excluded.name,
          phone = excluded.phone,
          status = case when users.status = 'disabled' then 'invited' else users.status end,
          updated_at = now()
        returning *
      `, [userId, input.managerName, input.managerEmail, managerPhone]);

      const managerId = String(userResult.rows[0].id);
      await client.query(`
        insert into tenant_memberships (user_id, tenant_id, role)
        values ($1, $2, 'admin')
        on conflict (user_id, tenant_id) do update set role = 'admin'
      `, [managerId, slug]);

      await client.query(`
        insert into audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        values ($1, null, 'tenant.create', 'tenant', $1, $2::jsonb)
      `, [slug, JSON.stringify({ managerEmail: input.managerEmail })]);

      await client.query('commit');

      const tenant = rowTenant({
        ...tenantResult.rows[0],
        manager_name: userResult.rows[0].name,
        manager_email: userResult.rows[0].email,
        manager_phone: userResult.rows[0].phone,
      });
      const manager = rowUser({
        ...userResult.rows[0],
        role: 'admin',
        tenant_id: slug,
      });
      return { tenant, manager };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
}

export const adminStore: AdminStore = isPostgresConfigured()
  ? new PostgresAdminStore()
  : new InMemoryAdminStore();

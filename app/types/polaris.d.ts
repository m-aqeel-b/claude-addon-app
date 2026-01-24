// Type declarations for Shopify Polaris web components
import type { DetailedHTMLProps, HTMLAttributes, ReactNode, CSSProperties } from 'react';

type BaseProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  style?: CSSProperties;
};

interface SPageProps extends BaseProps {
  heading?: string;
  'back-action'?: string;
  children?: ReactNode;
}

interface SButtonProps extends BaseProps {
  variant?: 'primary' | 'secondary' | 'tertiary';
  tone?: 'critical' | 'success';
  slot?: string;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}

interface SSectionProps extends BaseProps {
  heading?: string;
  slot?: string;
  children?: ReactNode;
}

interface SStackProps extends BaseProps {
  direction?: 'inline' | 'block';
  gap?: string;
  align?: string;
  wrap?: boolean;
  children?: ReactNode;
}

interface STextFieldProps extends BaseProps {
  label?: string;
  value?: string;
  type?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
  onInput?: (e: Event) => void;
  children?: ReactNode;
}

interface SSelectProps extends BaseProps {
  label?: string;
  value?: string;
  onChange?: (e: Event) => void;
  onInput?: (e: Event) => void;
  children?: ReactNode;
}

interface SOptionProps extends BaseProps {
  value?: string;
  selected?: boolean;
  defaultSelected?: boolean;
  children?: ReactNode;
}

interface SRadioGroupProps extends BaseProps {
  legend?: string;
  value?: string;
  onChange?: (e: Event) => void;
  children?: ReactNode;
}

interface SRadioProps extends BaseProps {
  value?: string;
  checked?: boolean;
  children?: ReactNode;
}

interface SCheckboxProps extends BaseProps {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (e: Event) => void;
  children?: ReactNode;
}

interface SBoxProps extends BaseProps {
  padding?: string;
  borderWidth?: string;
  borderRadius?: string;
  textAlign?: string;
  background?: string;
  onClick?: () => void;
  children?: ReactNode;
}

interface STextProps extends BaseProps {
  variant?: string;
  color?: string;
  children?: ReactNode;
}

interface SBadgeProps extends BaseProps {
  tone?: 'info' | 'success' | 'warning' | 'critical' | 'new';
  children?: ReactNode;
}

interface SCardProps extends BaseProps {
  children?: ReactNode;
}

interface SResourceItemProps extends BaseProps {
  id?: string;
  children?: ReactNode;
}

interface SResourceListProps extends BaseProps {
  children?: ReactNode;
}

interface SEmptyStateProps extends BaseProps {
  heading?: string;
  image?: string;
  children?: ReactNode;
}

interface SIconProps extends BaseProps {
  name?: string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      's-page': SPageProps;
      's-button': SButtonProps;
      's-section': SSectionProps;
      's-stack': SStackProps;
      's-text-field': STextFieldProps;
      's-select': SSelectProps;
      's-option': SOptionProps;
      's-radio-group': SRadioGroupProps;
      's-radio': SRadioProps;
      's-checkbox': SCheckboxProps;
      's-box': SBoxProps;
      's-text': STextProps;
      's-badge': SBadgeProps;
      's-card': SCardProps;
      's-resource-item': SResourceItemProps;
      's-resource-list': SResourceListProps;
      's-empty-state': SEmptyStateProps;
      's-icon': SIconProps;
    }
  }
}

export {};

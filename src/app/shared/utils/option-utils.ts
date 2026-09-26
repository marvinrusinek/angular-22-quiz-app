import { Option } from '@shared/models';

export function isValidOption(option: Option): boolean {
  return option && typeof option === 'object' && 'text' in option;
}